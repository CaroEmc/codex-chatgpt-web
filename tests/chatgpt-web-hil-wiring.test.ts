import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { CHATGPT_WEB_LUNA_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { DEV_CHAT_HIL_PROTOCOL_INSTRUCTIONS } from "../src/hil/protocol";
import type { ApprovalGateway, ExecProposal } from "../src/hil/approval";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

// This suite exercises only the `!mode.localTools` ("browser-only" / read-only) branch of
// `createChatGptWebAdapter`, which is what a real `--hil` daemon session routes through. It
// follows the same fake-`worker.run` monkeypatch convention already used throughout
// tests/chatgpt-web-harness.test.ts (there is no constructor-level worker injection seam on
// `createChatGptWebAdapter`).

const tempRoot = join(tmpdir(), `codex-chatgpt-web-hil-wiring-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const tools: CodexTool[] = [
  { name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true },
];

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

function parsed(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [{ role: "user", content: "Inspect the project", timestamp: 2 }],
    },
    options: { reasoning: "high" },
  };
}

function rawWireRequest(identitySuffix = "123"): CodexParsedRequest {
  const request = parsed();
  const turnId = `turn_test_${identitySuffix}`;
  const threadId = `thread_test_${identitySuffix}`;
  request._rawBody = {
    prompt_cache_key: threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `<environment_context>\n  <cwd>${tempRoot}</cwd>\n  <filesystem><workspace_roots><root>${tempRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>\n</environment_context>`,
        }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  return request;
}

function browserOnlyProvider(overrides: Partial<NonNullable<CodexProviderConfig["chatgptWeb"]>> = {}): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `browser://chatgpt-hil-wiring-${process.pid}-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      brokerSocketPath: brokerTestEndpoint(`cgw-hil-wiring-${process.pid}-${Date.now()}-${Math.random()}`),
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
      ...overrides,
    },
  };
}

// --- Finding 2: HIL must refuse the launcher browser host instead of silently going inert -----

test("createChatGptWebAdapter refuses HIL when the browser host is the launcher", () => {
  const provider = browserOnlyProvider({
    hilEnabled: true,
    browserHost: "launcher",
    browserHostDescriptorPath: join(tempRoot, "host.json"),
  });
  expect(() => createChatGptWebAdapter(provider)).toThrow(/HIL requires the managed-chrome browser host/);
});

test("the launcher helper client refuses a BrowserTurn carrying a hilExecGate", async () => {
  // The launcher run frame is an explicit field whitelist that cannot carry a live gate object, so
  // dispatching such a turn must fail loudly rather than drop the gate. Checked before the helper
  // process is started, so this needs no fake child.
  const client = new LauncherBrowserHelperClient({
    appName: "test",
    browserHost: "launcher",
    browserHostDescriptorPath: join(tempRoot, "host.json"),
  } as unknown as ConstructorParameters<typeof LauncherBrowserHelperClient>[0]);
  await expect(client.run({
    traceId: "trace_launcher_hil",
    modelId: CHATGPT_WEB_MODEL_ID,
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
    prepare: async () => ({ text: "prompt", images: [], release: () => {} }),
    onReasoningSummary: () => {},
    onCommentary: () => {},
    onTextDelta: () => {},
    hilExecGate: { check: async () => ({ action: "finalize" as const }) },
  } as unknown as BrowserTurn)).rejects.toThrow(/does not support human-in-the-loop local exec/);
});

test("browser-only runTurn wires hilExecGate onto the BrowserTurn when hilEnabled", async () => {
  const provider = browserOnlyProvider({ hilEnabled: true });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let capturedTurn: BrowserTurn | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    capturedTurn = turn;
    turn.onTextDelta("final answer");
    return Promise.resolve("final answer");
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(rawWireRequest(), { headers: new Headers() }, () => {});
    expect(capturedTurn?.hilExecGate).toBeDefined();
    // Finding 6: the model is actually told the protocol exists, otherwise the gate can never fire.
    const prepared = await capturedTurn!.prepare();
    expect(prepared.text).toContain(DEV_CHAT_HIL_PROTOCOL_INSTRUCTIONS);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
  }
});

test("browser-only runTurn leaves hilExecGate undefined when hilEnabled is not set (default)", async () => {
  const provider = browserOnlyProvider();
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let capturedTurn: BrowserTurn | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    capturedTurn = turn;
    turn.onTextDelta("final answer");
    return Promise.resolve("final answer");
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    await adapter.runTurn!(rawWireRequest(), { headers: new Headers() }, () => {});
    expect(capturedTurn?.hilExecGate).toBeUndefined();
    const prepared = await capturedTurn!.prepare();
    expect(prepared.text).not.toContain("[EXEC_REQUEST]");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
  }
});

test(
  "the raw EXEC_REQUEST protocol block never reaches Codex's transcript across a simulated resume round, "
  + "even though only the last round's text feeds the worker.run return value",
  async () => {
    const provider = browserOnlyProvider({ hilEnabled: true });
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    const preText = "Let me check the repository first.\n";
    const execBlock = "[EXEC_REQUEST]\ncommand: ls\nreason: list files\n[/EXEC_REQUEST]";
    const postText = "Found 3 files; the project builds cleanly.";
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
      // Simulate browser-worker's real multi-round HIL behavior (Task 5): every round's text
      // is delivered via onTextDelta as it streams (browser-worker resets its own markdown
      // buffer on every HIL resume), but the eventual resolved promise carries ONLY the LAST
      // round's text -- never the full multi-round accumulation. This is the exact shape Task 5's
      // reviewer flagged: the accumulated text/trace arrays built from onTextDelta (not the
      // return value) are what must carry the full exchange forward to emit.
      turn.onTextDelta(preText);
      turn.onTextDelta(execBlock);
      turn.onTextDelta(postText);
      return Promise.resolve(postText);
    };
    try {
      const adapter = createChatGptWebAdapter(provider);
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(rawWireRequest(), { headers: new Headers() }, event => events.push(event));

      const emittedText = events
        .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
          event.type === "text_delta" && event.phase === "final_answer"
        ))
        .map(event => event.text)
        .join("");

      expect(emittedText).not.toContain("[EXEC_REQUEST");
      expect(emittedText).not.toContain("[/EXEC_REQUEST]");
      expect(emittedText).toBe(preText + postText);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    }
  },
);

test(
  "text buffered by the HIL emit filter is flushed, not silently dropped, when the round ends "
  + "via the error path instead of another emitRoundBatch call",
  async () => {
    const provider = browserOnlyProvider({ hilEnabled: true });
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
      // A lone "[" is a strict prefix of "[EXEC_REQUEST", so the filter holds it back pending
      // more text to disambiguate. Draining this delta (via the incremental text-wait loop)
      // leaves it buffered inside the round's shared filter instance; the round then ends via
      // the error path (`emitRoundEvent`) instead of another emitRoundBatch call, which used to
      // bypass the filter entirely and silently drop the buffered "[".
      turn.onTextDelta("[");
      return new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new ChatGptWebAdapterError("simulated upstream stall", {
          status: 502,
          errorType: "server_error",
          code: "test_simulated_stall",
          retryable: false,
        })), 30);
      });
    };
    try {
      const adapter = createChatGptWebAdapter(provider);
      const events: AdapterEvent[] = [];
      await adapter.runTurn!(rawWireRequest(), { headers: new Headers() }, event => events.push(event));

      const emittedText = events
        .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
          event.type === "text_delta" && event.phase === "final_answer"
        ))
        .map(event => event.text)
        .join("");
      expect(emittedText).toBe("[");
      expect(events.at(-1)).toMatchObject({ type: "error", code: "test_simulated_stall" });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    }
  },
);

test("a compaction checkpoint turn carries no hilExecGate and no protocol instructions", async () => {
  // Compaction turns are told not to call tools and only summarize; a blocking approval prompt
  // (or an exec gate) has no place in one.
  const provider = browserOnlyProvider({ hilEnabled: true });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let capturedTurn: BrowserTurn | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    capturedTurn = turn;
    turn.onTextDelta("summary");
    return Promise.resolve("summary");
  };
  try {
    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest("789");
    request._compactionRequest = true;
    await adapter.runTurn!(request, { headers: new Headers() }, () => {});
    expect(capturedTurn?.compaction).toBe(true);
    expect(capturedTurn?.hilExecGate).toBeUndefined();
    const prepared = await capturedTurn!.prepare();
    expect(prepared.text).not.toContain("[EXEC_REQUEST]");
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
  }
});

// --- Finding 3: one shared, serialized approval surface for concurrent turns ------------------

test("concurrent HIL turns never hold two approval prompts open at once and are labelled by traceId", async () => {
  // Up to MAX_CHATGPT_BROWSER_TABS turns run at once against ONE daemon stdin. Two overlapping
  // TtyApprovalGateway prompts would open two readline interfaces on that single stream.
  const seen: ExecProposal[] = [];
  let live = 0;
  let maxLive = 0;
  const gateway: ApprovalGateway = {
    request: async proposal => {
      seen.push(proposal);
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise(resolve => setTimeout(resolve, 20));
      live -= 1;
      return { action: "reject" };
    },
  };
  const provider = browserOnlyProvider({ hilEnabled: true });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const verdict = await turn.hilExecGate!.check(
      "[EXEC_REQUEST]\ncommand: echo hi\n[/EXEC_REQUEST]",
      turn.abortSignal,
    );
    expect(verdict).toEqual({ action: "resume", followUpText: "User rejected execution." });
    turn.onTextDelta("done");
    return "done";
  };
  try {
    const adapter = createChatGptWebAdapter(provider, { hilApprovalGateway: gateway });
    const first = rawWireRequest();
    // A distinct native thread/turn identity, so the two calls are separate executions rather
    // than one deduplicated session replay.
    const second = rawWireRequest("456");
    second.context.messages = [{ role: "user", content: "A different request", timestamp: 3 }];
    await Promise.all([
      adapter.runTurn!(first, { headers: new Headers() }, () => {}),
      adapter.runTurn!(second, { headers: new Headers() }, () => {}),
    ]);
    expect(seen).toHaveLength(2);
    expect(maxLive).toBe(1);
    const traceIds = seen.map(proposal => proposal.traceId);
    expect(traceIds.every(traceId => typeof traceId === "string" && traceId.length > 0)).toBe(true);
    expect(new Set(traceIds).size).toBe(2);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
  }
});

// --- Finding 4: HIL must stand down when Luna rolling checkpoint capture owns the turn ---------

test("a Luna rolling-checkpoint turn disables HIL entirely (no gate, no emit filter, one warning)", async () => {
  const provider = browserOnlyProvider({ hilEnabled: true, solAvailable: false });
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const answer = "Answer with a literal [EXEC_REQUEST]\ncommand: ls\n[/EXEC_REQUEST] sample inside it.";
  let capturedTurn: BrowserTurn | undefined;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
    capturedTurn = turn;
    turn.onTextDelta(answer);
    return Promise.resolve(answer);
  };
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest();
    request.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
    request.options = { reasoning: "low" };
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));

    // No gate: a Luna turn's checkpoint stream is created once per turn and is not reset on a HIL
    // resume, so a second round would be swallowed by the latched marker or trip the
    // duplicate-marker consistency error.
    expect(capturedTurn?.captureLunaCheckpoint).toBe(true);
    expect(capturedTurn?.hilExecGate).toBeUndefined();
    // And no emit filter either: withholding text for a gate that will never run would silently
    // drop a chunk of the answer from Codex's transcript.
    const emittedText = events
      .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
        event.type === "text_delta" && event.phase === "final_answer"
      ))
      .map(event => event.text)
      .join("");
    expect(emittedText).toBe(answer);
    expect(warnings.some(line => line.includes(
      "HIL local exec is disabled for this turn because Luna rolling checkpoint capture is active",
    ))).toBe(true);
  } finally {
    console.warn = originalWarn;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
  }
});
