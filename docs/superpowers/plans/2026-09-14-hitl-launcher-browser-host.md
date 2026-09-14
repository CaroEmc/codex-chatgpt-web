# HITL Local Exec Over the Launcher Browser Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codex-chatgpt-web serve --hitl` work with `browserHost: "launcher"`, so human-in-the-loop local exec is reachable on Linux and Windows (where standalone managed-Chrome CLI setup is unavailable), not just macOS managed-Chrome.

**Architecture:** The launcher browser host runs the DOM-automation loop inside a separate child process (`browser-helper-main.ts`) talked to over newline-delimited JSON on stdio by `LauncherBrowserHelperClient` (`launcher-helper-client.ts`) in the daemon. Today the daemon refuses any turn carrying a `hitlExecGate` because that's a live JS callback object that can't cross the IPC boundary. This plan adds a new paired `hitl_exec_request`/`hitl_exec_result_ack` message, mirroring the existing `completion_fence_begin`/`completion_fence_begin_ack` round-trip already used for the MCP tool-call race: the child detects turn completion is pending on a `[EXEC_REQUEST]` block, asks the daemon over IPC, the daemon runs the existing (unmodified) `createHitlExecGate` approval-and-exec logic using its own TTY, and replies with either `finalize` or `resume` + follow-up text.

**Tech Stack:** TypeScript, Bun test runner, Node child_process/readline (the existing daemon↔helper JSON-lines protocol).

**Spec:** `docs/superpowers/specs/2026-09-14-hitl-launcher-browser-host-design.md`

## Global Constraints

- `src/adapters/chatgpt-web/index.ts` and `src/adapters/chatgpt-web/browser-worker.ts` must not change — `hitlExecGate` already flows through `worker.run(turn)` into `LauncherBrowserHelperClient.run(turn)` unmodified; only that method's behavior changes.
- The daemon-side `createHitlExecGate`/`HitlApprovalQueue`/`TtyApprovalGateway` logic in `src/adapters/chatgpt-web/hitl-interceptor.ts` and `src/hitl/*` must not change — it is invoked from a new call site, not modified.
- New protocol messages must follow the exact shape and validation strictness of the existing `completion_fence_begin`/`completion_fence_begin_ack` pair (same file, same patterns) — no new abstractions.
- Feature-gate the new capability behind `"hitl-exec-gate"` in the helper's `ready` message `features` array, exactly like `"completion-fence"`, `"tool-boundary-ack"`, `"multipart-stage-ack"` are gated today.
- No launcher (Electron/renderer) UI changes — CLI-flag-only, out of scope per the spec.
- No changes to `docs/hitl_prd.md`'s `[EXEC_REQUEST]`/`[EXEC_RESULT]` text protocol.

---

## Task 1: Remove the construction-time guard blocking HITL on the launcher browser host

**Files:**
- Modify: `src/adapters/chatgpt-web/index.ts:371-380`
- Test: `tests/chatgpt-web-hitl-wiring.test.ts:96-103`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createChatGptWebAdapter` no longer throws for `{ hitlEnabled: true, browserHost: "launcher" }`. Later tasks rely on this — Task 2's round-trip test constructs turns with `hitlExecGate` set while `browserHost` is `"launcher"`.

- [ ] **Step 1: Update the test to expect success instead of a throw**

Replace the test at `tests/chatgpt-web-hitl-wiring.test.ts:96-103`:

```typescript
test("createChatGptWebAdapter no longer refuses HITL when the browser host is the launcher", () => {
  const provider = browserOnlyProvider({
    hitlEnabled: true,
    browserHost: "launcher",
    browserHostDescriptorPath: join(tempRoot, "host.json"),
  });
  expect(() => createChatGptWebAdapter(provider)).not.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/chatgpt-web-hitl-wiring.test.ts -t "no longer refuses HITL"`
Expected: FAIL — the current code at `index.ts:371-380` still throws
`"ChatGPT HITL requires the managed-chrome browser host; the launcher browser host cannot carry the HITL exec gate"`.

- [ ] **Step 3: Remove the guard**

In `src/adapters/chatgpt-web/index.ts`, delete this block (currently lines 371-380):

```typescript
  if (hitlActive && provider.chatgptWeb?.browserHost === "launcher") {
    // The launcher browser host runs every turn inside a helper process behind an IPC frame whose
    // `turn` payload is an explicit field whitelist; a live `hitlExecGate` object cannot cross it.
    // Refusing here (rather than silently dropping the gate in launcher-helper-client) keeps the
    // daemon from running turns whose `[EXEC_REQUEST]` block is filtered out of Codex's transcript
    // while the command is never actually proposed or run.
    throw new Error(
      "ChatGPT HITL requires the managed-chrome browser host; the launcher browser host cannot carry the HITL exec gate",
    );
  }
```

Leave everything around it (the `hitlApprovals` construction two lines below) unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/chatgpt-web-hitl-wiring.test.ts -t "no longer refuses HITL"`
Expected: PASS

- [ ] **Step 5: Run the full hitl-wiring test file to confirm no regressions**

Run: `bun test tests/chatgpt-web-hitl-wiring.test.ts`
Expected: All tests PASS, including `"the launcher helper client refuses a BrowserTurn carrying a hitlExecGate"` (still throws today — Task 2 changes *why* it throws, not whether it throws in that specific no-child test).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/chatgpt-web/index.ts tests/chatgpt-web-hitl-wiring.test.ts
git commit -m "$(cat <<'EOF'
feat: allow HITL construction with the launcher browser host

Removes the construction-time refusal so createChatGptWebAdapter no
longer blocks hitlEnabled + browserHost: launcher up front. The
launcher-helper-client still refuses to actually dispatch such a turn
until it can carry the exec gate over IPC (next commit).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R4Xq5eZkvqLmYcrEwiVRAT
EOF
)"
```

---

## Task 2: Wire the `hitl_exec_request`/`hitl_exec_result_ack` protocol round-trip

**Files:**
- Modify: `src/adapters/chatgpt-web/launcher-helper-client.ts` (daemon side)
- Modify: `src/adapters/chatgpt-web/browser-helper-main.ts` (child side)
- Modify: `tests/chatgpt-web-hitl-wiring.test.ts:105-123` (comment accuracy only, assertion unchanged)
- Test: `tests/launcher-helper-client.test.ts` (new test, appended after the existing tests)

**Interfaces:**
- Consumes: `HitlExecGate` interface from `src/adapters/chatgpt-web/hitl-interceptor.ts` — `{ check(finalText: string, abortSignal?: AbortSignal): Promise<{ action: "finalize" } | { action: "resume"; followUpText: string }> }`. `BrowserTurn.hitlExecGate?: HitlExecGate` from `src/adapters/chatgpt-web/browser-worker.ts`.
- Produces: `LauncherBrowserHelperClient.run(turn)` dispatches a turn whose `hitlExecGate` is set, as long as the connected helper has advertised `"hitl-exec-gate"`; the daemon's `hitlExecGate.check()` is invoked from a new `handleLine` branch and its result relayed back to the child, which resumes or finalizes the browser turn accordingly. This is the end state Task 1's guard removal was preparing for.

### Part A — write the failing end-to-end test first

- [ ] **Step 1: Add the round-trip test**

Append to `tests/launcher-helper-client.test.ts` (it already imports everything needed — `LauncherBrowserHelperClient`, `LAUNCHER_BROWSER_HOST_KIND`, `LAUNCHER_BROWSER_IDLE_URL`, `mkdtempSync`, `tmpdir`, `join`, `writeFileSync`):

```typescript
test("HITL exec gate round-trips finalize and resume decisions through the real helper process", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-hitl-"));
  roots.push(root);
  const helper = join(root, "helper.ts");
  writeFileSync(helper, `
    import { ChatGptBrowserWorker } from ${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url).href)};
    // Substitute only the browser. Both sides of the production IPC protocol run unchanged.
    ChatGptBrowserWorker.prototype.run = async turn => {
      await turn.onPreparedSelected(false);
      await turn.prepare();
      await turn.onSendActivated();
      turn.onSubmitted();
      // First round settles on an [EXEC_REQUEST] block; the gate is expected to resume it.
      const first = await turn.hitlExecGate.check("[EXEC_REQUEST]\\ncommand: echo hi\\ncwd: .\\nreason: test\\n[/EXEC_REQUEST]");
      if (first.action !== "resume") throw new Error("expected the gate to resume the first round");
      turn.onTextDelta(first.followUpText);
      // Second round settles on ordinary text; the gate is expected to finalize it.
      const second = await turn.hitlExecGate.check("all done");
      if (second.action !== "finalize") throw new Error("expected the gate to finalize the second round");
      turn.onTextDelta("all done");
      return "all done";
    };
    await import(${JSON.stringify(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url).href)});
  `, { mode: 0o700 });
  const descriptorHelper = join(root, "descriptor-helper.cjs");
  writeFileSync(descriptorHelper, "process.exit(99);\n", { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39003",
    control: {
      endpoint: "http://127.0.0.1:39004",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: descriptorHelper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native2",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    browserHelperScriptPath: helper,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const checkCalls: string[] = [];
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "hitl_roundtrip_123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "inspect", images: [], release: () => {} }),
      onSendActivated: () => {},
      onSubmitted: () => {},
      onReasoningSummary: () => {},
      onTextDelta: () => {},
      hitlExecGate: {
        check: async finalText => {
          checkCalls.push(finalText);
          if (finalText.includes("[EXEC_REQUEST]")) return { action: "resume", followUpText: "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]" };
          return { action: "finalize" };
        },
      },
    } as unknown as Parameters<typeof client.run>[0]);
    expect(result).toBe("all done");
    expect(checkCalls).toEqual([
      "[EXEC_REQUEST]\ncommand: echo hi\ncwd: .\nreason: test\n[/EXEC_REQUEST]",
      "all done",
    ]);
  } finally {
    await client.close();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/launcher-helper-client.test.ts -t "HITL exec gate round-trips"`
Expected: FAIL — today `LauncherBrowserHelperClient.run()` throws immediately
(`"does not support human-in-the-loop local exec"`) because `turn.hitlExecGate`
is set and the guard is still unconditional.

### Part B — daemon side: `launcher-helper-client.ts`

- [ ] **Step 3: Add the `hitl_exec_request` variant to `HelperMessage`**

In `src/adapters/chatgpt-web/launcher-helper-client.ts`, in the `HelperMessage` union (currently lines 26-45), insert a new variant right after the `completion_fence_commit` line:

```typescript
  | { type: "event"; id: string; event: "completion_fence_commit"; requestId: number; revision: number }
  | { type: "event"; id: string; event: "hitl_exec_request"; requestId: number; text: string }
  | { type: "event"; id: string; event: "prepared_selected"; reused: boolean }
```

- [ ] **Step 4: Validate it in `parseHelperMessage`**

In the same file's `parseHelperMessage` function, right after the `completion_fence_commit` parsing block (currently ending around line 96, just before the `luna_checkpoint` block), insert:

```typescript
    if (event === "hitl_exec_request") {
      if (!Number.isSafeInteger(message.requestId) || (message.requestId as number) <= 0) {
        throw new Error("Launcher browser helper HITL exec request id is invalid");
      }
      if (typeof message.text !== "string") {
        throw new Error("Launcher browser helper HITL exec request text is invalid");
      }
      return { type: "event", id: message.id, event, requestId: message.requestId as number, text: message.text };
    }
```

- [ ] **Step 5: Feature-gate `run()` instead of unconditionally refusing**

Replace the current block at `launcher-helper-client.ts:211-221`:

```typescript
    if (turn.hitlExecGate) {
      // The run frame below is an explicit field whitelist, and `hitlExecGate` is a live object with
      // a method: it cannot cross this IPC boundary at all, and no helper feature can make it. This
      // is checked before the helper is even started, because a silently dropped gate would finish
      // the turn with the `[EXEC_REQUEST]` block filtered out of Codex's transcript (the parent
      // process still runs that filter) and the command never proposed or run.
      throw new Error(
        "Launcher browser host does not support human-in-the-loop local exec; HITL requires the managed-chrome browser host",
      );
    }
    await this.ensureChild();
```

with:

```typescript
    await this.ensureChild();
    if (turn.hitlExecGate && !this.helperFeatures.has("hitl-exec-gate")) {
      // The helper connected but never advertised hitl-exec-gate support: an older launcher build.
      // Refusing here (rather than silently dropping the gate) keeps the daemon from running a turn
      // whose [EXEC_REQUEST] block would be filtered out of Codex's transcript while the command is
      // never actually proposed or run.
      throw new Error(
        "Launcher browser helper does not support human-in-the-loop local exec; update or restart the launcher",
      );
    }
```

Note this moves the check to *after* `await this.ensureChild()`, because the feature can only be known once the helper's `ready` message has been received — unlike the old blanket refusal, this one is a real capability check, not a static fact about the browser host.

- [ ] **Step 6: Include `hitl: true` in the outbound run frame**

In the same file, in the `run` frame constructed a few lines later (currently around lines 291-304), add one line after `...(turn.externalProgress ? { externalProgress: true } : {}),`:

```typescript
          turn: {
            traceId: turn.traceId,
            modelId: turn.modelId,
            reasoning: turn.reasoning,
            capabilities: turn.capabilities,
            ...(turn.nativeConnector ? { nativeConnector: true } : {}),
            ...(turn.prepareResume ? { resumeAvailable: true } : {}),
            ...(turn.retainConversation ? { retainConversation: true } : {}),
            ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
            ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
            ...(turn.compaction ? { compaction: true } : {}),
            ...(turn.captureLunaCheckpoint ? { captureLunaCheckpoint: true } : {}),
            ...(turn.externalProgress ? { externalProgress: true } : {}),
            ...(turn.hitlExecGate ? { hitl: true } : {}),
          },
```

- [ ] **Step 7: Handle the `hitl_exec_request` event in `handleLine`**

In the same file's `handleLine` method, right after the `completion_fence_commit` branch closes (currently ending around line 490, just before `else if (message.event === "send_activated")`), insert:

```typescript
      else if (message.event === "hitl_exec_request") {
        const gate = pending.turn.hitlExecGate;
        if (!gate) {
          this.abortWithLocalFailure(
            message.id,
            new Error("Launcher browser helper requested HITL exec approval for a turn without a gate"),
            pending,
          );
          return;
        }
        void gate.check(message.text, pending.turn.abortSignal).then(result => {
          if (this.pending.get(message.id) !== pending || pending.localFailure || pending.turn.abortSignal?.aborted) return;
          return this.send({
            type: "hitl_exec_result_ack",
            id: message.id,
            requestId: message.requestId,
            ...result,
          });
        }).catch(error => this.abortWithLocalFailure(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
          pending,
        ));
      }
```

### Part C — child side: `browser-helper-main.ts`

- [ ] **Step 8: Import the `HitlExecGate` type**

At the top of `src/adapters/chatgpt-web/browser-helper-main.ts`, next to the existing `import { ChatGptBrowserWorker, closeChatGptBrowserWorkers, type BrowserTurn } from "./browser-worker";`, add:

```typescript
import type { HitlExecGate } from "./hitl-interceptor";
```

- [ ] **Step 9: Add `hitl` to `RunMessage.turn`**

In the `RunMessage` interface (currently lines 13-37), add one field to the `turn` object type, after `externalProgress?: boolean;`:

```typescript
    externalProgress?: boolean;
    hitl?: boolean;
```

- [ ] **Step 10: Add the `hitl_exec_result_ack` variant to `InputMessage`**

In the `InputMessage` union (currently lines 62-70), insert right after the `completion_fence_commit_ack` line:

```typescript
  | { type: "completion_fence_commit_ack"; id: string; requestId: number; committed: boolean }
  | { type: "hitl_exec_result_ack"; id: string; requestId: number; action: "finalize" }
  | { type: "hitl_exec_result_ack"; id: string; requestId: number; action: "resume"; followUpText: string }
  | { type: "progress"; id: string; snapshot: ChatGptExternalTurnProgressSnapshot }
```

- [ ] **Step 11: Add the waiter map**

Next to the existing `completionFenceCommitWaiters` declaration (currently lines 102-106), add:

```typescript
const hitlExecWaiters = new Map<string, {
  requestId: number;
  resolve: (result: { action: "finalize" } | { action: "resume"; followUpText: string }) => void;
  reject: (error: Error) => void;
}>();
let hitlExecRequestId = 0;
```

- [ ] **Step 12: Reject pending HITL waiters on shutdown**

In `requestShutdown()`, right after the existing `completionFenceCommitWaiters.clear();` line (currently line 134), add:

```typescript
  for (const waiter of hitlExecWaiters.values()) {
    waiter.reject(new DOMException("Browser helper is shutting down", "AbortError"));
  }
  hitlExecWaiters.clear();
```

- [ ] **Step 13: Validate the new turn field in `run()`**

Right after the existing `externalProgress` validation block in `run()` (currently lines 177-179):

```typescript
  if (message.turn.externalProgress !== undefined && typeof message.turn.externalProgress !== "boolean") {
    throw new Error("Browser helper external progress flag is invalid");
  }
```

add:

```typescript
  if (message.turn.hitl !== undefined && typeof message.turn.hitl !== "boolean") {
    throw new Error("Browser helper HITL flag is invalid");
  }
```

- [ ] **Step 14: Construct the local `hitlExecGate` on the turn object**

In `run()`'s `turn: BrowserTurn` object literal (currently lines 209-299), add a new conditional block. Place it after the `completionFence`/`externalProgress` spread block closes (after the `} : {}),` on the line matching `completionFence: { ... }` around line 252) and before `onHeartbeat:`:

```typescript
    ...(message.turn.hitl ? {
      hitlExecGate: {
        check: (finalText: string) => new Promise<{ action: "finalize" } | { action: "resume"; followUpText: string }>((resolve, reject) => {
          if (hitlExecWaiters.has(message.id)) {
            reject(new Error("Browser helper HITL exec gate already awaits a result"));
            return;
          }
          hitlExecRequestId += 1;
          const requestId = hitlExecRequestId;
          hitlExecWaiters.set(message.id, { requestId, resolve, reject });
          if (!writeProtocol({ type: "event", id: message.id, event: "hitl_exec_request", requestId, text: finalText })) {
            hitlExecWaiters.delete(message.id);
            reject(new Error("Browser helper could not request HITL exec approval"));
          }
        }),
      } satisfies HitlExecGate,
    } : {}),
```

- [ ] **Step 15: Reject the waiter in the `finally` block if the turn ends first**

In `run()`'s `finally` block (currently lines 316-329), right after the existing `commitWaiter?.reject(...)` line, add:

```typescript
    const hitlWaiter = hitlExecWaiters.get(message.id);
    hitlExecWaiters.delete(message.id);
    hitlWaiter?.reject(new DOMException("Browser helper turn ended before HITL exec approval", "AbortError"));
```

- [ ] **Step 16: Handle the ack in the incoming-message dispatch**

In the `input.on("line", ...)` handler, right after the `completion_fence_commit_ack` branch closes (currently ending around line 448, just before `else if (message.type === "progress")`), insert:

```typescript
  } else if (message.type === "hitl_exec_result_ack") {
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0) {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper HITL exec request id is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (message.action !== "finalize" && message.action !== "resume") {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper HITL exec action is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    if (message.action === "resume" && typeof message.followUpText !== "string") {
      writeProtocol({ type: "error", id: message.id, message: "Browser helper HITL exec follow-up text is invalid" });
      abortControllers.get(message.id)?.abort();
      return;
    }
    const waiter = hitlExecWaiters.get(message.id);
    if (!waiter || waiter.requestId !== message.requestId) return;
    hitlExecWaiters.delete(message.id);
    waiter.resolve(message.action === "finalize" ? { action: "finalize" } : { action: "resume", followUpText: message.followUpText });
```

(This is an `} else if` clause like its siblings — match the existing brace style of the surrounding chain exactly; see `completion_fence_commit_ack` immediately above it for the pattern.)

- [ ] **Step 17: Reject the waiter when the daemon aborts the turn**

In the `abort` message handler (currently lines 465-478), right after the existing `commitWaiter?.reject(...)` line, add:

```typescript
    const hitlWaiter = hitlExecWaiters.get(message.id);
    hitlExecWaiters.delete(message.id);
    hitlWaiter?.reject(new DOMException("Browser helper turn aborted before HITL exec approval", "AbortError"));
```

- [ ] **Step 18: Advertise the new feature**

Change line 520:

```typescript
writeProtocol({ type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence", "multipart-stage-ack"] });
```

to:

```typescript
writeProtocol({ type: "ready", features: ["progress", "tool-boundary-ack", "completion-fence", "multipart-stage-ack", "hitl-exec-gate"] });
```

### Part D — verify and finish

- [ ] **Step 19: Run the new round-trip test**

Run: `bun test tests/launcher-helper-client.test.ts -t "HITL exec gate round-trips"`
Expected: PASS

- [ ] **Step 20: Replace the no-child test with a real-but-feature-less helper**

Moving the feature check after `ensureChild()` (Step 5) is architecturally required — `helperFeatures` is only known once a helper has actually connected and sent its `ready` message, so there is no way to test "the connected helper lacks the feature" without a real connection. The old test's shortcut (a `browserHostDescriptorPath` pointing at a file that was never written) no longer reaches the feature-gate check at all: `readLauncherBrowserHostDescriptor` (`src/launcher-browser-host.ts:154`) throws `"Launcher browser host is unavailable: descriptor is missing at ${path}"` first, inside `ensureChild()`.

Replace the test at `tests/chatgpt-web-hitl-wiring.test.ts:105-123` with a version that spawns a real, minimal helper stub which connects successfully but advertises no features:

```typescript
test("the launcher helper client refuses a BrowserTurn carrying a hitlExecGate when the helper hasn't advertised support", async () => {
  // A connected helper that hasn't advertised "hitl-exec-gate" cannot carry a live gate object
  // across the IPC boundary, so dispatching such a turn must fail loudly rather than drop the gate.
  // The feature is only knowable after a real connection (ensureChild), so this spawns a minimal
  // real helper stub that advertises no features at all, rather than reusing a build of the actual
  // browser-helper-main.ts (which now always advertises hitl-exec-gate after this same commit).
  const helper = join(tempRoot, "featureless-helper.cjs");
  writeFileSync(helper, "process.stdout.write(JSON.stringify({ type: \"ready\", features: [] }) + \"\\n\");\n", { mode: 0o700 });
  const descriptorPath = join(tempRoot, "featureless-host.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 3,
    kind: "codex-chatgpt-web-launcher-browser-host",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:0",
    control: { endpoint: "http://127.0.0.1:0", token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank",
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { launcher_surface_id_0123456789AB: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "test",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
  } as unknown as ConstructorParameters<typeof LauncherBrowserHelperClient>[0]);
  try {
    await expect(client.run({
      traceId: "trace_launcher_hitl",
      modelId: CHATGPT_WEB_MODEL_ID,
      capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: false },
      prepare: async () => ({ text: "prompt", images: [], release: () => {} }),
      onReasoningSummary: () => {},
      onCommentary: () => {},
      onTextDelta: () => {},
      hitlExecGate: { check: async () => ({ action: "finalize" as const }) },
    } as unknown as BrowserTurn)).rejects.toThrow(/does not support human-in-the-loop local exec/);
  } finally {
    await client.close();
  }
});
```

Check the exact string for `kind` against `LAUNCHER_BROWSER_HOST_KIND` (imported in `tests/launcher-helper-client.test.ts` from `src/launcher-browser-host.ts`) rather than hardcoding it — import that constant into `tests/chatgpt-web-hitl-wiring.test.ts` too and use it in place of the literal string above, to stay correct if the constant's value ever changes.

- [ ] **Step 21: Run it to confirm the new failure reason**

Run: `bun test tests/chatgpt-web-hitl-wiring.test.ts -t "refuses a BrowserTurn carrying a hitlExecGate"`
Expected: PASS.

- [ ] **Step 22: Run the full test suite for both changed files**

Run: `bun test tests/chatgpt-web-hitl-wiring.test.ts tests/launcher-helper-client.test.ts`
Expected: All PASS.

- [ ] **Step 23: Typecheck**

Run: `bun x --no-install --bun tsc --noEmit`
Expected: No errors. Pay particular attention to `browser-helper-main.ts`'s `hitlExecGate` object satisfying the imported `HitlExecGate` interface, and to the `HelperMessage`/`InputMessage` union additions being exhaustively handled.

- [ ] **Step 24: Commit**

```bash
git add src/adapters/chatgpt-web/launcher-helper-client.ts src/adapters/chatgpt-web/browser-helper-main.ts tests/launcher-helper-client.test.ts tests/chatgpt-web-hitl-wiring.test.ts
git commit -m "$(cat <<'EOF'
feat: carry the HITL exec gate over the launcher helper IPC protocol

Adds a hitl_exec_request/hitl_exec_result_ack round-trip mirroring the
existing completion_fence_begin/commit pattern, so a turn's
hitlExecGate.check() call - still fully owned and executed by the
daemon (TTY approval, command execution, all unchanged) - can be
proxied across the daemon/helper-child process boundary instead of
being refused outright. Gated behind a new hitl-exec-gate helper
feature so an old launcher build fails clearly instead of silently
dropping the gate.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01R4Xq5eZkvqLmYcrEwiVRAT
EOF
)"
```

---

## Task 3: Full verification pass

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-2.
- Produces: confidence the change is safe to merge; no new interfaces.

- [ ] **Step 1: Run the full test suite**

Run: `bun test ./tests`
Expected: All tests PASS (no regressions anywhere else — this change is additive and touches no other feature's code paths).

- [ ] **Step 2: Run the launcher's own test suite**

Run: `bun run launcher:test`
Expected: PASS (the launcher package's own tests don't touch this protocol, but confirm nothing else broke).

- [ ] **Step 3: Typecheck both packages**

Run: `bun run typecheck && bun run launcher:typecheck`
Expected: No errors.

- [ ] **Step 4: Manual smoke check (optional but recommended before considering this done)**

If a real launcher build and a Linux/Windows machine are available: install a launcher-owned browser host per the updated launcher build, run `codex-chatgpt-web setup --browser-only --acknowledge-unofficial --browser-host-descriptor <path-to-running-launcher's-descriptor>` (or reuse an existing config already pointed at the launcher), then `codex-chatgpt-web serve --hitl` in a real terminal, and drive a Codex turn that triggers a local command. Confirm the `[AI EXECUTION PROPOSAL]` TTY prompt appears and that approving it lets the turn continue. This step requires a running launcher and is not part of the automated test suite — skip it if no such environment is available, but note that it hasn't been done.

- [ ] **Step 5: Confirm no stray files**

Run: `git status`
Expected: Clean (only the commits from Tasks 1-2; no leftover scratch files from test runs — `tests/launcher-helper-client.test.ts`'s tests already clean up their own `mkdtempSync` roots via the file-level `afterEach`).
