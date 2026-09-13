# HIL Production Daemon Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the `[EXEC_REQUEST]`/`[EXEC_RESULT]` human-in-the-loop local-exec
protocol into the production daemon's `chatgpt-web` adapter, so a real,
foreground, `browser-only`-mode daemon session can pause a live browser turn
for TTY approval, run the approved command locally, and continue the same
turn — without touching `full` mode, the MCP connector, the OpenAI Tunnel,
`src/bridge.ts`, or the daemon's round/session journaling.

**Architecture:** A new `hilExecGate` hook inside `runBrowserTurn`'s own
completion-detection loop (`src/adapters/chatgpt-web/browser-worker.ts`)
intercepts the turn-finalization decision: on a well-formed `[EXEC_REQUEST]`,
it runs the (moved-but-unchanged) approval/exec pipeline from the dev-chat
prototype, then submits the result as a follow-up message into the same
already-open browser page and keeps observing — all inside one
`worker.run()` call, so round/session bookkeeping never sees more than one
logical turn. A small emit-side filter in `src/adapters/chatgpt-web/index.ts`
keeps the raw protocol block out of Codex's own transcript.

**Tech Stack:** TypeScript, Bun test runner, Playwright (via existing
`browser-worker.ts` automation), Node `child_process`/`readline` (via the
existing `src/hil/*` modules).

**Spec:** `docs/superpowers/specs/2026-09-13-hil-daemon-integration-design.md`
(read this too — it explains *why* the mechanism is shaped this way,
including a rejected cross-invocation approach in its §2).

## Global Constraints

- HIL is honored only when **both** `config.mode === "browser-only"` and
  `process.stdin.isTTY` is true at daemon startup; otherwise the daemon logs
  a warning and runs with HIL disabled for the whole process (spec §3).
- `full` mode, the MCP connector, the OpenAI Tunnel, `src/bridge.ts`, and the
  daemon's round/session journaling (`src/adapters/chatgpt-web/turn-execution.ts`)
  are **never** touched by any task in this plan (spec §10).
- Execution mechanics are unchanged from the dev-chat prototype: 60s
  `child_process.spawn` timeout, 10KB combined stdout+stderr truncation,
  cwd resolved against the workspace root with pre-approval rejection for any
  path that escapes it (`src/hil/exec.ts`, moved verbatim in Task 1).
- When `hilExecGate`/the emit filter are not engaged (the default for every
  existing daemon session — all of `full` mode, and any `browser-only` turn
  without `--hil`), behavior must be byte-for-byte unchanged from today. Every
  task that touches shared code (`browser-worker.ts`, `index.ts`) must keep
  its new branch behind an `if (turn.hilExecGate)` / `if (config.hilEnabled)`
  check with no other code path altered.
- No new abstraction beyond what's specified below — reuse `src/hil/*`
  unchanged; do not re-implement parsing/approval/exec logic anywhere else.

---

### Task 1: Move shared HIL modules to `src/hil/`

**Files:**
- Create: `src/hil/protocol.ts` (moved from `src/dev-chat/hil-protocol.ts`, byte-identical)
- Create: `src/hil/approval.ts` (moved from `src/dev-chat/hil-approval.ts`, byte-identical)
- Create: `src/hil/exec.ts` (moved from `src/dev-chat/hil-exec.ts`, byte-identical)
- Modify: `src/dev-chat/hil-protocol.ts` (replace body with a re-export)
- Modify: `src/dev-chat/hil-approval.ts` (replace body with a re-export)
- Modify: `src/dev-chat/hil-exec.ts` (replace body with a re-export)
- Test: `tests/hil-protocol.test.ts` (moved from `tests/hil-protocol.test.ts`'s current import path — update the import)
- Test: `tests/hil-approval.test.ts` (update the import)
- Test: `tests/hil-exec.test.ts` (update the import)

**Interfaces:**
- Produces (for every later task): `src/hil/protocol.ts` exports
  `parseExecRequest(text: string): ParsedExecRequest | undefined`,
  `formatExecResult(exitCode: number, output: string): string`,
  `EXEC_REJECTED_TEXT: string`, `DEV_CHAT_HIL_PROTOCOL_INSTRUCTIONS: string`,
  and the `ParsedExecRequest` interface (`{ command: string; cwd?: string; reason?: string }`).
  `src/hil/approval.ts` exports `ApprovalGateway`, `ExecProposal`,
  `ApprovalDecision`, `TtyApprovalGateway`. `src/hil/exec.ts` exports
  `runApprovedCommand(gateway: ApprovalGateway, request: RawExecRequest, workspaceCwd: string): Promise<string>`
  and `RawExecRequest`.

- [ ] **Step 1: Copy the three modules verbatim into `src/hil/`**

Read each of `src/dev-chat/hil-protocol.ts`, `src/dev-chat/hil-approval.ts`,
`src/dev-chat/hil-exec.ts` and write identical copies to `src/hil/protocol.ts`,
`src/hil/approval.ts`, `src/hil/exec.ts` respectively — same code, same
exports. The only edit needed is `src/hil/exec.ts`'s import line, which
currently reads:

```ts
import type { ApprovalGateway } from "./hil-approval";
import { EXEC_REJECTED_TEXT, formatExecResult } from "./hil-protocol";
```

Change to:

```ts
import type { ApprovalGateway } from "./approval";
import { EXEC_REJECTED_TEXT, formatExecResult } from "./protocol";
```

- [ ] **Step 2: Replace the three `src/dev-chat/hil-*.ts` files with re-exports**

`src/dev-chat/hil-protocol.ts` becomes:

```ts
export * from "../hil/protocol";
```

`src/dev-chat/hil-approval.ts` becomes:

```ts
export * from "../hil/approval";
```

`src/dev-chat/hil-exec.ts` becomes:

```ts
export * from "../hil/exec";
```

- [ ] **Step 3: Update the three existing HIL test files' imports**

In `tests/hil-protocol.test.ts`, change the import from
`"../src/dev-chat/hil-protocol"` to `"../src/hil/protocol"`. Do the same for
`tests/hil-approval.test.ts` (→ `"../src/hil/approval"`) and
`tests/hil-exec.test.ts` (→ `"../src/hil/exec"`). Do not change any test
body — these tests already cover the moved code fully; the move alone
doesn't need new tests.

- [ ] **Step 4: Run the full existing HIL and dev-chat test suites**

Run: `bun test tests/hil-protocol.test.ts tests/hil-approval.test.ts tests/hil-exec.test.ts tests/dev-chat.test.ts`
Expected: all pass, identical results to before the move (confirms the
re-export preserves dev-chat's behavior and the moved tests still cover the
same code).

- [ ] **Step 5: Commit**

```bash
git add src/hil/ src/dev-chat/hil-protocol.ts src/dev-chat/hil-approval.ts src/dev-chat/hil-exec.ts tests/hil-protocol.test.ts tests/hil-approval.test.ts tests/hil-exec.test.ts
git commit -m "refactor: move HIL protocol/approval/exec modules to src/hil/"
```

---

### Task 2: `hilEnabled` config field and activation gating

**Files:**
- Modify: `src/config.ts` — add `hilEnabled: boolean` to `AppConfig`
  (alongside `mode: RuntimeMode` at `src/config.ts:65-96`), and add a new
  exported helper.
- Test: `tests/config-hil.test.ts` (new)

**Interfaces:**
- Consumes: nothing new from earlier tasks.
- Produces: `AppConfig.hilEnabled: boolean` field; a new exported function
  `resolveHilActivation(requested: boolean, mode: RuntimeMode, stdinIsTty: boolean): { enabled: boolean; warning?: string }`
  that later tasks (3, 6) call to decide daemon-wide HIL activation and to
  get the exact warning text to log when activation is refused.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import { resolveHilActivation } from "../src/config";

test("resolveHilActivation enables HIL only for browser-only mode with an attached TTY", () => {
  expect(resolveHilActivation(true, "browser-only", true)).toEqual({ enabled: true });
});

test("resolveHilActivation refuses full mode even if a TTY is attached", () => {
  const result = resolveHilActivation(true, "full", true);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HIL requires browser-only mode; the daemon is running in full mode. HIL is disabled for this process.",
  );
});

test("resolveHilActivation refuses a headless daemon even in browser-only mode", () => {
  const result = resolveHilActivation(true, "browser-only", false);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HIL requires an attached terminal (process.stdin.isTTY); this daemon process is headless. HIL is disabled for this process.",
  );
});

test("resolveHilActivation is inert when HIL was not requested", () => {
  expect(resolveHilActivation(false, "browser-only", true)).toEqual({ enabled: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/config-hil.test.ts`
Expected: FAIL — `resolveHilActivation is not a function` (or import error).

- [ ] **Step 3: Add `hilEnabled` to `AppConfig` and implement `resolveHilActivation`**

In `src/config.ts`, add the field to the `AppConfig` interface right after
`mode: RuntimeMode;` (`src/config.ts:69`):

```ts
export interface AppConfig {
  version: 3;
  purpose?: "dev-harness";
  releaseVersion: string;
  mode: RuntimeMode;
  hilEnabled: boolean;
  // ...unchanged fields below...
```

Add `hilEnabled: false` to `defaultConfig`'s returned object (wherever the
function at `src/config.ts:193` constructs its default `AppConfig` literal —
add the field alongside `mode`, defaulting to `false`).

Add the new exported function, near `tunnelConfigForInteractionMode`
(`src/config.ts:99-108`):

```ts
export function resolveHilActivation(
  requested: boolean,
  mode: RuntimeMode,
  stdinIsTty: boolean,
): { enabled: boolean; warning?: string } {
  if (!requested) return { enabled: false };
  if (mode !== "browser-only") {
    return {
      enabled: false,
      warning: "HIL requires browser-only mode; the daemon is running in full mode. HIL is disabled for this process.",
    };
  }
  if (!stdinIsTty) {
    return {
      enabled: false,
      warning: "HIL requires an attached terminal (process.stdin.isTTY); this daemon process is headless. HIL is disabled for this process.",
    };
  }
  return { enabled: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/config-hil.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config-hil.test.ts
git commit -m "feat: add hilEnabled config field and resolveHilActivation gate"
```

---

### Task 3: `--hil` startup flag in `src/cli.ts`/`src/server.ts`

**Files:**
- Modify: `src/cli.ts` — add `--hil` flag parsing next to the existing
  `--browser-only`/`--full` flags (`src/cli.ts:263-265`), help text update.
- Modify: `src/server.ts` — apply `resolveHilActivation` when starting the
  daemon and set `config.hilEnabled` accordingly, logging the warning if
  refused.
- Test: `tests/cli-hil-flag.test.ts` (new)

**Interfaces:**
- Consumes: `resolveHilActivation` from Task 2 (`src/config.ts`).
- Produces: nothing new consumed by later tasks — this task only wires
  startup plumbing. Later tasks read `config.hilEnabled` directly.

- [ ] **Step 1: Write the failing test**

This test exercises the flag-parsing helper in isolation rather than the
full CLI process. Find the function in `src/cli.ts` that currently reads
`--browser-only`/`--full` and throws `"Choose exactly one setup mode: --browser-only or --full"`
(`src/cli.ts:263-265`) — call it `F` (its actual name; read the surrounding
~20 lines to find it, since this plan does not repeat the whole setup-parsing
function). Confirm `F` is exported (add `export` to its declaration if it
isn't already) and add the following test importing it:

```ts
import { expect, test } from "bun:test";
// Replace `F` with the actual exported name found in src/cli.ts.
import { F } from "../src/cli";

test("--hil combined with --full is rejected with a clear error", () => {
  expect(() => F(["--full", "--hil"])).toThrow(/--hil requires --browser-only/);
});

test("--hil alone with --browser-only is accepted", () => {
  const result = F(["--browser-only", "--hil"]);
  expect(result.hil).toBe(true);
});
```

Adjust the exact assertions once you've read `F`'s real return shape — the
binding requirement is: **`--hil` combined with `--full` throws an error
containing `"--hil requires --browser-only"`**, and `--hil` alone with
`--browser-only` produces a truthy `hil`/`hilRequested` flag in whatever
options object `F` already returns for `browserOnly`/`full`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/cli-hil-flag.test.ts`
Expected: FAIL (flag not recognized / no `hil` field on the result / no throw).

- [ ] **Step 3: Add the flag**

In `src/cli.ts`, next to `const browserOnly = takeFlag(args, "--browser-only");`
and `const full = takeFlag(args, "--full");` (`src/cli.ts:263-264`), add:

```ts
const hil = takeFlag(args, "--hil");
if (hil && full) {
  throw new Error("--hil requires --browser-only (full mode already has real tool calls)");
}
```

Add `hil` to whatever options object this function returns (matching the
existing pattern for `browserOnly`/`full` in the same object literal).
Update the CLI help text (find the usage block containing `--browser-only`
and `--full`, e.g. near `src/cli.ts:49`, and add a line: `--hil   Enable
human-in-the-loop local exec (browser-only mode, foreground only)`).

- [ ] **Step 4: Wire `resolveHilActivation` into `src/server.ts`'s startup path**

Find where `src/server.ts` reads the parsed CLI options and constructs or
updates the persisted `AppConfig` before starting to listen (grep for where
`config.mode` is assigned at startup). Immediately after `config.mode` is
set, add:

```ts
import { resolveHilActivation } from "./config";
// ...
const hilActivation = resolveHilActivation(options.hil === true, config.mode, process.stdin.isTTY === true);
config.hilEnabled = hilActivation.enabled;
if (hilActivation.warning) console.warn(`[server] ${hilActivation.warning}`);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/cli-hil-flag.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the existing CLI/server test suites for regressions**

Run: `bun test tests/server-lifecycle.test.ts`
Expected: all pass, unchanged (no test in that suite sets `--hil`, so this
confirms the new code path is inert for every existing scenario).

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/server.ts tests/cli-hil-flag.test.ts
git commit -m "feat: add --hil startup flag with browser-only+TTY gating"
```

---

### Task 4: `hil-interceptor.ts` — the exec gate and the emit filter

**Files:**
- Create: `src/adapters/chatgpt-web/hil-interceptor.ts`
- Test: `tests/hil-interceptor.test.ts` (new)

**Interfaces:**
- Consumes: `ApprovalGateway`, `runApprovedCommand`, `RawExecRequest` from
  `src/hil/exec.ts`; `parseExecRequest` from `src/hil/protocol.ts` (all from
  Task 1).
- Produces (for Tasks 5 and 6):
  - `createHilExecGate(deps: { approvalGateway: ApprovalGateway; workspaceCwd: string; runCommand?: typeof runApprovedCommand }): HilExecGate`
    where `HilExecGate = { check(finalText: string): Promise<{ action: "finalize" } | { action: "resume"; followUpText: string }> }`.
  - `createHilEmitFilter<TEvent extends { type: string; text?: string }>(realEmit: (event: TEvent) => void): (event: TEvent) => void`
    — see exact behavior in Step 3 below; Task 6 wires this in front of the
    adapter's `emit` calls for `text_delta` events specifically.

- [ ] **Step 1: Write the failing tests for `createHilExecGate`**

```ts
import { expect, test } from "bun:test";
import { createHilExecGate } from "../src/adapters/chatgpt-web/hil-interceptor";
import type { ApprovalGateway, ApprovalDecision } from "../src/hil/approval";

function fakeGateway(decision: ApprovalDecision): ApprovalGateway {
  return { request: async () => decision };
}

test("createHilExecGate finalizes when there is no EXEC_REQUEST block", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    workspaceCwd: "/workspace",
  });
  expect(await gate.check("Just a normal final answer.")).toEqual({ action: "finalize" });
});

test("createHilExecGate resumes with the formatted EXEC_RESULT after an approved run", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "run", command: "echo hi" }),
    workspaceCwd: "/workspace",
    runCommand: async (_gateway, request, workspaceCwd) => {
      expect(request.command).toBe("echo hi");
      expect(workspaceCwd).toBe("/workspace");
      return "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]";
    },
  });
  const text = "[EXEC_REQUEST]\ncommand: echo hi\n[/EXEC_REQUEST]";
  expect(await gate.check(text)).toEqual({
    action: "resume",
    followUpText: "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]",
  });
});

test("createHilExecGate resumes with the rejection text when the gateway rejects", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    workspaceCwd: "/workspace",
  });
  const text = "[EXEC_REQUEST]\ncommand: rm -rf /\n[/EXEC_REQUEST]";
  expect(await gate.check(text)).toEqual({
    action: "resume",
    followUpText: "User rejected execution.",
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/hil-interceptor.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Write `createHilExecGate` and `createHilEmitFilter`**

```ts
import { parseExecRequest } from "../../hil/protocol";
import { runApprovedCommand, type RawExecRequest } from "../../hil/exec";
import type { ApprovalGateway } from "../../hil/approval";

export interface HilExecGate {
  check(finalText: string): Promise<
    | { action: "finalize" }
    | { action: "resume"; followUpText: string }
  >;
}

export interface HilExecGateDeps {
  approvalGateway: ApprovalGateway;
  workspaceCwd: string;
  /** Injected for testability; defaults to the real src/hil/exec.ts implementation. */
  runCommand?: (gateway: ApprovalGateway, request: RawExecRequest, workspaceCwd: string) => Promise<string>;
}

export function createHilExecGate(deps: HilExecGateDeps): HilExecGate {
  const runCommand = deps.runCommand ?? runApprovedCommand;
  return {
    async check(finalText) {
      const request = parseExecRequest(finalText);
      if (!request) return { action: "finalize" };
      const followUpText = await runCommand(deps.approvalGateway, request, deps.workspaceCwd);
      return { action: "resume", followUpText };
    },
  };
}

/**
 * Withholds the raw `[EXEC_REQUEST]...[/EXEC_REQUEST]` protocol block from
 * reaching Codex's transcript. Buffers `text_delta` text since the last
 * flush; flushes verbatim once the buffered text can no longer be a prefix
 * of `[EXEC_REQUEST]`, or drops it once it completes a well-formed block
 * (parseExecRequest succeeds) — the exec gate handles the block itself via
 * `check()`, so Codex never needs to see it.
 */
export function createHilEmitFilter<TEvent extends { type: string; text?: string }>(
  realEmit: (event: TEvent) => void,
): (event: TEvent) => void {
  let buffered = "";
  const flush = () => {
    if (buffered) realEmit({ type: "text_delta", text: buffered } as TEvent);
    buffered = "";
  };
  return (event: TEvent) => {
    if (event.type !== "text_delta" || typeof event.text !== "string") {
      flush();
      realEmit(event);
      return;
    }
    const candidate = buffered + event.text;
    if (!candidate.includes("[") && !buffered) {
      realEmit(event);
      return;
    }
    const prefixIndex = candidate.indexOf("[EXEC_REQUEST");
    if (prefixIndex === -1 && !candidate.startsWith("[") && !"[EXEC_REQUEST".startsWith(candidate.slice(-1))) {
      flush();
      buffered = candidate;
      flush();
      return;
    }
    buffered = candidate;
    if (parseExecRequest(buffered)) {
      buffered = "";
      return;
    }
    if (buffered.includes("[/EXEC_REQUEST]") && !parseExecRequest(buffered)) {
      flush();
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/hil-interceptor.test.ts`
Expected: PASS (3 tests for `createHilExecGate`).

- [ ] **Step 5: Add failing tests for `createHilEmitFilter`, then make them pass**

Append to `tests/hil-interceptor.test.ts`:

```ts
import { createHilEmitFilter } from "../src/adapters/chatgpt-web/hil-interceptor";

test("createHilEmitFilter passes ordinary text straight through", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "hello " });
  filtered({ type: "text_delta", text: "world" });
  expect(seen).toEqual([
    { type: "text_delta", text: "hello " },
    { type: "text_delta", text: "world" },
  ]);
});

test("createHilEmitFilter withholds a completed EXEC_REQUEST block entirely", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[EXEC_REQUEST]\n" });
  filtered({ type: "text_delta", text: "command: ls\n[/EXEC_REQUEST]" });
  filtered({ type: "done" });
  expect(seen).toEqual([{ type: "done" }]);
});

test("createHilEmitFilter flushes verbatim when a [-prefixed delta turns out not to match", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[not a protocol block]" });
  expect(seen).toEqual([{ type: "text_delta", text: "[not a protocol block]" }]);
});
```

Run: `bun test tests/hil-interceptor.test.ts`
Expected: PASS (6 tests total). If any fail, adjust `createHilEmitFilter`'s
buffering logic (not the tests) until the three behaviors above hold —
the exact buffering algorithm above is a reference implementation, not a
frozen contract; the binding requirement is the three test outcomes.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/chatgpt-web/hil-interceptor.ts tests/hil-interceptor.test.ts
git commit -m "feat: add HIL exec gate and Codex-transcript emit filter"
```

---

### Task 5: `hilExecGate` hook in `browser-worker.ts`

This is the highest-risk task in this plan — it touches the daemon's largest,
most heavily-tested file. Read this task brief fully before editing; do not
touch any code outside what's specified.

**Files:**
- Modify: `src/adapters/chatgpt-web/browser-worker.ts`
- Test: `tests/browser-worker-hil-gate.test.ts` (new)

**Interfaces:**
- Consumes: `HilExecGate` type from Task 4
  (`src/adapters/chatgpt-web/hil-interceptor.ts`) — import only the type,
  not the factory function (this file must not depend on `parseExecRequest`
  or approval/exec logic directly; `hilExecGate` is injected by the caller,
  Task 6).
- Produces: a new optional field `hilExecGate?: HilExecGate` on the
  `BrowserTurn` interface (`browser-worker.ts:1144-1178` area) that Task 6
  sets.

**Background (already investigated — do not re-derive):** `runBrowserTurn`'s
completion loop (`browser-worker.ts`, the `for (;;)` starting ~line 4774)
computes `completionReady` (~line 4912) via `completionTracker.update(...)`.
When true, if `turn.completionFence` exists it gates finalization via
`begin()`/`commit()` (~lines 4921-4945), looping back with a 250ms sleep if
it declines. Right after that block currently finalizes unconditionally:

```ts
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = (() => {
              try {
                return markdownBuffer.finish();
              } catch (error) {
                return throwMarkdownConsistencyError(error);
              }
            })();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            break;
```

Several loop-scoped variables declared before the loop (~lines 4738-4770)
must become reassignable so a follow-up submission can reset them:
`markdownBuffer`, `visibleTrace`, `domHealthTracker` are currently declared
with `const` and must change to `let`. `responseTurn` (declared `let` just
before the loop, from `waitForNewAssistantTurn`) and `submissionBaseline`
(declared `let` earlier in the method) are already reassignable.
`loggedCompletionWait`, `capturedResponse`, `sentAt`, `completionFenceRevision`
are already `let`.

- [ ] **Step 1: Add the `HilExecGate` type import and the new `BrowserTurn` field**

At the top of `browser-worker.ts`, add:

```ts
import type { HilExecGate } from "./hil-interceptor";
```

In the `BrowserTurn` interface (`browser-worker.ts:1144-1178`), add, right
after the existing `completionFence` field:

```ts
  /** Content-driven alternative to declaring the turn finished: on a match,
   * submits a follow-up into the same page instead of finalizing. */
  hilExecGate?: HilExecGate;
```

- [ ] **Step 2: Change three `const` declarations to `let`**

At `browser-worker.ts:4745-4746` and `:4768` (the declarations right before
the completion loop), change:

```ts
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownBuffer = new ChatGptMarkdownBuffer();
```

to:

```ts
      let visibleTrace = new ChatGptVisibleTraceTracker();
      let markdownBuffer = new ChatGptMarkdownBuffer();
```

and:

```ts
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
```

to:

```ts
      let domHealthTracker = new ChatGptTurnDomHealthTracker();
```

- [ ] **Step 3: Insert the `hilExecGate` branch before finalization**

Immediately before `if (snapshot.visibleText === "api_tool unavailable") { ... }`
(the block quoted in Background above), insert:

```ts
            if (turn.hilExecGate) {
              const verdict = await turn.hilExecGate.check(snapshot.visibleText);
              if (verdict.action === "resume") {
                submissionBaseline = await this.captureSubmissionBaseline(page);
                await this.attachPromptWithCompactionRetry(
                  page,
                  verdict.followUpText,
                  mode.localTools,
                  false,
                  submissionBaseline,
                  checkpoint => diagnostics.capture(page, checkpoint),
                  turn.abortSignal,
                  false,
                  connectorAttemptBudget,
                  reuseConversation,
                  mode.thinkEnabled,
                );
                await this.sendAttachedPrompt(
                  page,
                  submissionBaseline,
                  checkpoint => diagnostics.capture(page, checkpoint),
                  turn.abortSignal,
                  turn.externalProgress,
                  turn,
                  completionTracker,
                  undefined,
                );
                responseTurn = await this.waitForNewAssistantTurn(
                  page,
                  submissionBaseline,
                  deadline,
                  turn.abortSignal,
                  turn.externalProgress,
                  CHATGPT_RESPONSE_DOM_GRACE_MS,
                  completionTracker,
                  undefined,
                );
                visibleTrace = new ChatGptVisibleTraceTracker();
                markdownBuffer = new ChatGptMarkdownBuffer();
                domHealthTracker = new ChatGptTurnDomHealthTracker();
                completionFenceRevision = undefined;
                loggedCompletionWait = false;
                capturedResponse = false;
                sentAt = Date.now();
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                continue;
              }
            }
```

`connectorAttemptBudget` and `reuseConversation` are already in scope from
earlier in `runBrowserTurn` (used by the main submission flow above the
loop) — do not redeclare them. `sentAt` is declared `const` earlier
(`browser-worker.ts:4744`); change that declaration to `let sentAt = Date.now();`
as well, alongside the Step 2 changes.

- [ ] **Step 4: Suppress the turn deadline while `hilExecGate` is present**

At `browser-worker.ts:4364-4366`:

```ts
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
```

change to:

```ts
      const deadline = this.config.turnTimeoutMs === undefined || turn.hilExecGate !== undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
```

This reuses `turn.hilExecGate`'s mere presence as the "no deadline" signal —
no new `BrowserTurn` field is needed, since HIL turns always want an
unbounded deadline (spec §5) and never need a *different* bounded one.

- [ ] **Step 5: Run the existing `browser-worker-contract.test.ts` suite for regressions**

Run: `bun test tests/browser-worker-contract.test.ts`
Expected: all pass, unchanged — every existing `BrowserTurn` in that suite
has `hilExecGate: undefined`, so both the Step 3 branch and the Step 4
deadline change are inert and every other line is untouched.

- [ ] **Step 6: Write the new HIL-gate tests**

Model the fake `Page`/DOM harness from the closest existing tests in
`tests/browser-worker-contract.test.ts` — specifically
`"an accepted Full-mode send survives one stalled DOM probe and a later MCP batch without resending"`
and the Bigger-Context multipart tests near the end of that file, since both
already drive `runBrowserTurn` through more than one submit-and-observe
cycle. Reuse their harness-construction helpers rather than writing a new
fake `Page` from scratch. Write `tests/browser-worker-hil-gate.test.ts` with
at least these cases:

1. A `hilExecGate` whose `check()` returns `{ action: "resume", followUpText: "[EXEC_RESULT]\n...\n[/EXEC_RESULT]" }` on the first call and `{ action: "finalize" }` on the second: assert the fake page's composer/send-button interactions happen twice (once for the original prompt, once for the follow-up with the exact `followUpText`), and that `worker.run(...)`'s returned promise resolves only after the second `finalize`.
2. A worker configured with a finite `turnTimeoutMs` (e.g. `1_000`) and a `hilExecGate` present on the turn, whose `check()` artificially delays past that configured timeout (e.g. `await new Promise(r => setTimeout(r, 1_100))` — long enough to exceed the configured `turnTimeoutMs` but short enough to keep the test fast): assert the turn does **not** throw `"ChatGPT web turn timed out"`, confirming Step 4's deadline suppression. Add a second case with the same finite `turnTimeoutMs` but `hilExecGate: undefined`, asserting the existing timeout behavior is unchanged when HIL isn't active.
3. A case asserting `turn.hilExecGate` is never consulted when it is `undefined` (i.e. today's existing tests already cover this implicitly via Step 5, but add one explicit assertion here that a turn with no `hilExecGate` field finalizes on the first `completionReady` exactly as before).

- [ ] **Step 7: Run the new tests, iterate until passing**

Run: `bun test tests/browser-worker-hil-gate.test.ts`
Expected: PASS. If the harness reveals the exact `attachPromptWithCompactionRetry`/`sendAttachedPrompt`/`waitForNewAssistantTurn` argument list in Step 3 needs adjustment (e.g. a parameter this plan listed as `undefined` needs a real value for the fake harness to observe correctly), fix the implementation in Step 3 to match the file's real call conventions — the test is the source of truth for correctness here, not this plan's literal code block.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/chatgpt-web/browser-worker.ts tests/browser-worker-hil-gate.test.ts
git commit -m "feat: add hilExecGate hook to runBrowserTurn's completion loop"
```

---

### Task 6: Wire the gate and emit filter into `index.ts`

**Files:**
- Modify: `src/adapters/chatgpt-web/index.ts`
- Test: `tests/chatgpt-web-hil-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `createHilExecGate`, `createHilEmitFilter` from Task 4
  (`src/adapters/chatgpt-web/hil-interceptor.ts`); `TtyApprovalGateway` from
  `src/hil/approval.ts` (Task 1); `AppConfig.hilEnabled` from Task 2 (reaches
  this adapter via a new `provider.chatgptWeb.hilEnabled` field — see Step 0
  — since `createChatGptWebAdapter(provider: CodexProviderConfig, ...)` does
  not receive `AppConfig` directly; confirmed by reading
  `src/adapters/chatgpt-web/index.ts:339-345`).
- Produces: nothing further consumed by later tasks (this is the last task).

- [ ] **Step 0: Thread `hilEnabled` and a workspace root through `CodexProviderConfig.chatgptWeb`**

In `src/types.ts`, add two fields to the `chatgptWeb` object type
(`src/types.ts:262-306`), next to the existing `turnTimeoutMs?: number`:

```ts
    /** Enables the HIL exec gate for browser-only turns (spec: docs/superpowers/specs/2026-09-13-hil-daemon-integration-design.md). */
    hilEnabled?: boolean;
    /** Workspace root EXEC_REQUEST cwd resolution is bounded to. Defaults to process.cwd(). */
    hilWorkspaceCwd?: string;
```

In `src/server.ts`, find where other `AppConfig` fields that mirror this
same `chatgptWeb` shape (e.g. `turnTimeoutMs`, `headed`, `localToolsEnabled`,
`autoApproveToolCalls`, `experimentalBiggerContext` — all listed in
`src/types.ts:262-306`) are copied from the loaded `AppConfig` into the
`CodexProviderConfig` passed to the adapter factory for a real request (grep
`src/server.ts` for `turnTimeoutMs:` or `autoApproveToolCalls:` to find this
mapping site — every sibling field takes the identical path). Add
`hilEnabled: config.hilEnabled` and `hilWorkspaceCwd: process.cwd()`
alongside them, using the same `config` binding those sibling fields already
read from.

- [ ] **Step 1: Write the failing test**

This test exercises `createChatGptWebAdapter`'s `!mode.localTools` branch
with a fake `worker` double (following the existing pattern the
`chatgpt-web` adapter test suite already uses to fake `ChatGptBrowserWorker`
— grep the existing adapter tests for how they construct a fake `worker`
object passed into `createChatGptWebAdapter`, and reuse that pattern rather
than inventing a new one).

```ts
import { expect, test } from "bun:test";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
// Import whatever fake-worker/fake-config helpers the existing chatgpt-web
// adapter tests already use (find them via the existing test file(s) that
// call createChatGptWebAdapter directly).

test("browser-only runTurn wires hilExecGate and an unbounded turnTimeoutMs when hilEnabled", async () => {
  let capturedTurn: { hilExecGate?: unknown; abortSignal?: AbortSignal } | undefined;
  const fakeWorker = {
    run: (turn: any) => {
      capturedTurn = turn;
      return Promise.resolve("final answer");
    },
  };
  const adapter = createChatGptWebAdapter(/* construct with config.hilEnabled = true, mode: "browser-only", a real or fake TtyApprovalGateway, and fakeWorker — match the existing test helper's constructor shape */);
  await new Promise<void>(resolve => {
    void adapter.runTurn(/* a minimal browser-only-mode CodexParsedRequest fixture, matching existing adapter tests' fixtures */, { headers: new Headers() }, () => {}).finally(resolve);
  });
  expect(capturedTurn?.hilExecGate).toBeDefined();
});
```

Adjust this test's setup to match whatever fixture/helper conventions the
existing `chatgpt-web` adapter test suite already uses (do not invent new
fixture shapes) — the binding assertion is: **when
`provider.chatgptWeb.hilEnabled` is true and the turn is in the
`!mode.localTools` branch, the `BrowserTurn` passed to `worker.run(...)` has
a defined `hilExecGate`.** (The deadline-suppression behavior itself is
already tested in Task 5 via `turn.hilExecGate`'s presence — this test only
confirms the field is wired, not the timeout behavior again.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/chatgpt-web-hil-wiring.test.ts`
Expected: FAIL — `capturedTurn.hilExecGate` is `undefined`.

- [ ] **Step 3: Wire it in `src/adapters/chatgpt-web/index.ts`**

At the top of the file, add:

```ts
import { createHilExecGate, createHilEmitFilter } from "./hil-interceptor";
```

In the `!mode.localTools` branch (`src/adapters/chatgpt-web/index.ts:672-707`,
the block quoted in the spec's §2/§6 and read during design), change:

```ts
    if (!mode.localTools) {
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
      })), browserAbort);
```

to:

```ts
    if (!mode.localTools) {
      const hilActive = provider.chatgptWeb?.hilEnabled === true;
      const browserTurn = cancellableBrowserTurn(finalizeCheckpoint(worker.run({
        traceId,
        modelId: parsed.modelId,
        reasoning: parsed.options.reasoning,
        capabilities: turnCapabilities,
        prepare: async () => ({
          ...compileChatGptWebPrompt(
            checkpointInput.parsed,
            turnCapabilities,
            undefined,
            compileOptionsFor(checkpointInput.parsed),
          ),
          release: () => {},
        }),
        abortSignal: browserAbort.signal,
        ...(parsed._compactionRequest ? { compaction: true } : {}),
        ...submissionLifecycle,
        ...multipartProgressLifecycle,
        onReasoningSummary: (text, continuation) => trace.push({ kind: "reasoning", text, ...(continuation ? { continuation: true } : {}) }),
        onCommentary: (text, continuation) => trace.push({ kind: "commentary", text, ...(continuation ? { continuation: true } : {}) }),
        onTextDelta: delta => text.push(delta),
        ...(captureLunaCheckpoint ? {
          captureLunaCheckpoint: true,
          onLunaCheckpoint: captureCheckpoint,
        } : {}),
        ...(hilActive ? {
          hilExecGate: createHilExecGate({
            approvalGateway: new TtyApprovalGateway(),
            workspaceCwd: provider.chatgptWeb?.hilWorkspaceCwd ?? process.cwd(),
          }),
        } : {}),
      })), browserAbort);
```

Task 5 already made `turn.hilExecGate`'s presence suppress the deadline
inside `browser-worker.ts` (`:4364-4366`) — no further timeout-related change
is needed here; setting `hilExecGate` above is sufficient.

Wrap `emit` with the Task 4 filter only for `text_delta` events reaching
Codex. Find where this `runTurn`'s outer `emit` parameter is used to
construct the events this branch's `trace`/`text` arrays eventually turn
into real `AdapterEvent`s sent to the bridge (search this same function for
where `trace`/`text` get turned into `emit({ type: "text_delta", ... })`
calls after the browser turn settles) and wrap that emission point with
`createHilEmitFilter(emit)` when `hilActive`, leaving it as plain `emit`
otherwise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/chatgpt-web-hil-wiring.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full existing `chatgpt-web` adapter and browser-worker suites for regressions**

Run: `bun test tests/browser-worker-contract.test.ts tests/browser-worker-hil-gate.test.ts tests/chatgpt-web-harness.test.ts tests/chatgpt-web-hil-wiring.test.ts tests/server-lifecycle.test.ts`
Expected: all pass. This confirms `hilEnabled: false` (today's default for
every existing test and every real daemon session without `--hil`) leaves
every existing code path byte-for-byte unchanged.

- [ ] **Step 6: Run the full project test suite**

Run: `bun test`
Expected: all pass (matching the pre-existing baseline noted in the plan's
Global Constraints — no unrelated regressions).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/chatgpt-web/index.ts tests/chatgpt-web-hil-wiring.test.ts
git commit -m "feat: wire hilExecGate and Codex-transcript emit filter into chatgpt-web adapter"
```
