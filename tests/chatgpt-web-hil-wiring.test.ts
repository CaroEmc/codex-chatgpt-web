import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
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

function rawWireRequest(): CodexParsedRequest {
  const request = parsed();
  const turnId = "turn_test_123";
  const threadId = "thread_test_123";
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
