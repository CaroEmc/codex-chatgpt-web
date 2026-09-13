import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { HilExecGate } from "../src/adapters/chatgpt-web/hil-interceptor";
import type { CodexProviderConfig } from "../src/types";

/**
 * The stub surface this harness drives `runBrowserTurn` through. Deliberately *not* expressed as
 * an intersection with `ChatGptBrowserWorker` — TS collapses `ClassType & { privateMember: X }`
 * to `never` whenever the object-literal member name collides with a private class member, which
 * every method stubbed below does. Casting straight to this standalone type (via `unknown`) is
 * what keeps `bun run typecheck` clean; `worker`'s real prototype methods are still installed for
 * the class's own use, this type just describes the seam this file replaces on the instance.
 */
type WorkerStubSurface = {
  runBrowserTurn: (
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation?: boolean,
  ) => Promise<string>;
  prepareTemporaryChatSurface: (...args: unknown[]) => Promise<void>;
  selectModelAndEffort: (...args: unknown[]) => Promise<unknown>;
  captureSubmissionBaseline: (...args: unknown[]) => Promise<unknown>;
  attachPromptWithCompactionRetry: (...args: unknown[]) => Promise<void>;
  sendAttachedPrompt: (...args: unknown[]) => Promise<string>;
  waitForNewAssistantTurn: (...args: unknown[]) => Promise<unknown>;
  responseDomSnapshot: (...args: unknown[]) => Promise<unknown>;
};

// A minimal chainable Playwright-Locator-shaped stub. The completion loop and its guard
// functions (throwIfChatGptSessionFailureAlert, throwIfChatGptTerminalErrorAlert, the stop
// button probe) only ever call `.filter()/.getByText()/.getByTestId()/.getByRole()/.last()`
// followed by `.isVisible()`/`.count()`; none of those checks need to find anything real here.
function chainable(): any {
  const node: any = {};
  node.filter = () => node;
  node.last = () => node;
  node.getByText = () => node;
  node.getByTestId = () => node;
  node.getByRole = () => node;
  node.locator = () => node;
  node.isVisible = async () => false;
  node.isEnabled = async () => true;
  node.count = async () => 0;
  node.waitFor = async () => {};
  node.press = async () => {};
  return node;
}

interface Harness {
  worker: WorkerStubSurface;
  page: Page;
  diagnosticsRoot: string;
  attachCalls: { prompt: string }[];
  sendCalls: number;
  hilChecks: string[];
  runTurn: (turn: Partial<BrowserTurn> & { onTextDelta: (delta: string) => void }) => Promise<string>;
  cleanup: () => void;
}

/**
 * Builds a fake-DOM harness that drives `runBrowserTurn` end to end (mode selection, prompt
 * attachment, send, and the completion polling loop) through the real orchestration method,
 * with every Playwright-facing leaf method stubbed. `maintenancePage` short-circuits real
 * browser-page acquisition (`runBrowserTurn`'s `browser_page` stage returns it directly), which
 * is what lets this run without a real Chrome instance.
 */
function buildHarness(options: {
  turnTimeoutMs?: number;
  /** visibleText returned by each successive assistant response, one entry per resume cycle */
  responses: string[];
}): Harness {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-hil-gate-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://hil-gate-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      localToolsEnabled: false,
      solAvailable: true,
      proAvailable: true,
      storageStatePath: `/tmp/hil-gate-${Date.now()}-${Math.random()}.json`,
      browserDiagnosticsPath: diagnosticsRoot,
      ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as WorkerStubSurface;

  const page = {
    isClosed: () => false,
    locator: () => chainable(),
    // Diagnostics captures swallow evaluate failures, but a bare stub avoids a spurious
    // "page.evaluate is not a function" warning on every checkpoint.
    evaluate: async () => ({
      location: { origin: "https://chatgpt.com", pathSegments: 0, temporaryChat: true },
      titleChars: 0,
      viewport: { width: 800, height: 600 },
      surfaceBound: false,
      bodyTextChars: 0,
      composer: { visibleCount: 1, textChars: [0], editors: [], selectedConnectorCount: 0, exactSelectedConnectorCount: 0 },
      focus: { tag: null, role: null, documentFocused: false },
      effortControls: [],
      effortItems: [],
      effortSliders: [],
      menus: [],
      connectorRows: [],
      overlays: [],
      turns: { user: 0, stopButtonCount: 0, assistant: [] },
    }),
  } as unknown as Page;

  const attachCalls: { prompt: string }[] = [];
  let sendCalls = 0;
  let responseTurnCalls = 0;

  worker.prepareTemporaryChatSurface = async () => {};
  worker.selectModelAndEffort = async () => ({
    modelId: CHATGPT_WEB_MODEL_ID,
    effort: "high",
    displayLabel: "High",
    uiEffortIndex: 2,
    thinkEnabled: false,
    localTools: false,
  });
  worker.captureSubmissionBaseline = async () => ({
    userTurns: chainable(),
    responseTurns: chainable(),
    initialTurnIdentities: [],
    domCache: {},
  });
  worker.attachPromptWithCompactionRetry = async (...args: unknown[]) => {
    attachCalls.push({ prompt: args[1] as string });
  };
  worker.sendAttachedPrompt = async () => {
    sendCalls += 1;
    return "assistant_message";
  };
  worker.waitForNewAssistantTurn = async () => {
    responseTurnCalls += 1;
    const identity = `assistant-turn-${responseTurnCalls}`;
    return { identity, locator: chainable(), acceptedTurnIdentities: [identity] };
  };
  worker.responseDomSnapshot = async () => {
    const visibleText = options.responses[responseTurnCalls - 1] ?? options.responses.at(-1)!;
    return {
      responsePresent: true,
      running: false,
      stoppedThinkingVisible: false,
      visibleText,
      fullHtml: `<p>${visibleText}</p>`,
      completionActionVisible: true,
      markdownSegments: [{
        key: "segment",
        html: `<p>${visibleText}</p>`,
        text: visibleText,
        streamable: false,
      }],
      traceBlocks: [],
    };
  };

  const runTurn = async (
    partial: Partial<BrowserTurn> & { onTextDelta: (delta: string) => void },
  ): Promise<string> => {
    const turn: BrowserTurn = {
      traceId: `hil-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      modelId: CHATGPT_WEB_MODEL_ID,
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
      prepare: async () => ({ text: "Hello Codex", images: [], release() {} }),
      ...partial,
    };
    return worker.runBrowserTurn(turn, undefined, page, false);
  };

  return {
    worker,
    page,
    diagnosticsRoot,
    attachCalls,
    get sendCalls() { return sendCalls; },
    hilChecks: [],
    runTurn,
    cleanup: () => rmSync(diagnosticsRoot, { recursive: true, force: true }),
  };
}

test("a resume verdict submits the exact follow-up text, and the turn only finalizes after the second check", async () => {
  const harness = buildHarness({ responses: ["first answer", "second answer"] });
  try {
    const checks: string[] = [];
    let finalized = false;
    const hilExecGate: HilExecGate = {
      async check(finalText) {
        checks.push(finalText);
        if (checks.length === 1) {
          return { action: "resume", followUpText: "[EXEC_RESULT]\nok\n[/EXEC_RESULT]" };
        }
        finalized = true;
        return { action: "finalize" };
      },
    };

    const deltas: string[] = [];
    const finalText = await harness.runTurn({
      onTextDelta: delta => deltas.push(delta),
      hilExecGate,
    });

    expect(checks).toEqual(["first answer", "second answer"]);
    expect(finalized).toBeTrue();
    // One attach+send for the original prompt, one more for the resumed follow-up.
    expect(harness.attachCalls.map(call => call.prompt)).toEqual([
      "Hello Codex",
      "[EXEC_RESULT]\nok\n[/EXEC_RESULT]",
    ]);
    expect(harness.sendCalls).toBe(2);
    expect(finalText).toBe("second answer");
  } finally {
    harness.cleanup();
  }
}, 20_000);

test("runBrowserTurn hands the turn's own abortSignal to every hilExecGate check", async () => {
  // The gate opens a blocking TTY prompt and then spawns a real shell command. Without the turn's
  // signal it cannot tell that Codex cancelled the turn while the operator was deciding, and would
  // run the command for a turn that no longer exists.
  const harness = buildHarness({ responses: ["first answer", "second answer"] });
  try {
    const abort = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const hilExecGate: HilExecGate = {
      async check(_finalText, abortSignal) {
        signals.push(abortSignal);
        return signals.length === 1
          ? { action: "resume", followUpText: "[EXEC_RESULT]\nok\n[/EXEC_RESULT]" }
          : { action: "finalize" };
      },
    };
    await harness.runTurn({ onTextDelta: () => {}, hilExecGate, abortSignal: abort.signal });
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal === abort.signal)).toBeTrue();
  } finally {
    harness.cleanup();
  }
}, 20_000);

test("two consecutive resume rounds stay inside one runBrowserTurn call without accumulating stale state", async () => {
  const harness = buildHarness({ responses: ["first answer", "second answer", "third answer"] });
  try {
    const checks: string[] = [];
    let finalized = false;
    const hilExecGate: HilExecGate = {
      async check(finalText) {
        checks.push(finalText);
        if (checks.length === 1) {
          return { action: "resume", followUpText: "[EXEC_RESULT]\nfirst\n[/EXEC_RESULT]" };
        }
        if (checks.length === 2) {
          return { action: "resume", followUpText: "[EXEC_RESULT]\nsecond\n[/EXEC_RESULT]" };
        }
        finalized = true;
        return { action: "finalize" };
      },
    };

    const finalText = await harness.runTurn({
      onTextDelta: () => {},
      hilExecGate,
    });

    expect(checks).toEqual(["first answer", "second answer", "third answer"]);
    expect(finalized).toBeTrue();
    // A third attach+send round for the second follow-up proves the loop kept resuming inside
    // this single runBrowserTurn call rather than only surviving exactly one round; a reset that
    // works once but silently leaves stale state (e.g. completionFenceRevision or
    // responseDomCache) would otherwise misfire or hang on this second resume.
    expect(harness.attachCalls.map(call => call.prompt)).toEqual([
      "Hello Codex",
      "[EXEC_RESULT]\nfirst\n[/EXEC_RESULT]",
      "[EXEC_RESULT]\nsecond\n[/EXEC_RESULT]",
    ]);
    expect(harness.sendCalls).toBe(3);
    expect(finalText).toBe("third answer");
  } finally {
    harness.cleanup();
  }
}, 20_000);

test("a finite turnTimeoutMs is suppressed while hilExecGate is present, but still enforced without it", async () => {
  const withGate = buildHarness({ turnTimeoutMs: 1_000, responses: ["slow answer"] });
  try {
    const hilExecGate: HilExecGate = {
      async check() {
        // Long enough to exceed the configured 1s turnTimeoutMs, short enough to keep the test fast.
        await new Promise(resolve => setTimeout(resolve, 1_100));
        return { action: "finalize" };
      },
    };
    const finalText = await withGate.runTurn({
      onTextDelta: () => {},
      hilExecGate,
    });
    expect(finalText).toBe("slow answer");
  } finally {
    withGate.cleanup();
  }
}, 20_000);

test("the existing finite turnTimeoutMs still fires when hilExecGate is absent", async () => {
  const withoutGate = buildHarness({ turnTimeoutMs: 250, responses: ["irrelevant"] });
  try {
    // Make the completion loop's own 250ms poll interval the reason it never observes completion
    // before the deadline: report the response as still running, so completionReady never becomes
    // true and the loop keeps sleeping until the deadline check at the top of the next iteration.
    withoutGate.worker.responseDomSnapshot = async () => ({
      responsePresent: true,
      running: true,
      stoppedThinkingVisible: false,
      visibleText: "still thinking",
      fullHtml: "<p>still thinking</p>",
      completionActionVisible: false,
      markdownSegments: [],
      traceBlocks: [],
    });
    await expect(withoutGate.runTurn({ onTextDelta: () => {} })).rejects.toThrow(
      "ChatGPT web turn timed out",
    );
  } finally {
    withoutGate.cleanup();
  }
}, 20_000);

test("a turn with no hilExecGate finalizes on the first completionReady exactly as before", async () => {
  const harness = buildHarness({ responses: ["only answer"] });
  try {
    const deltas: string[] = [];
    const finalText = await harness.runTurn({
      onTextDelta: delta => deltas.push(delta),
    });
    expect(finalText).toBe("only answer");
    // Exactly one attach+send: the hilExecGate branch never ran, so no follow-up was submitted.
    expect(harness.attachCalls).toHaveLength(1);
    expect(harness.sendCalls).toBe(1);
  } finally {
    harness.cleanup();
  }
}, 20_000);
