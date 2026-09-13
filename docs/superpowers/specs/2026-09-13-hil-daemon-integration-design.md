# Design: HIL Local Exec — Production Daemon Integration

## 1. Context & Objective

`docs/hil_prd.md` proposes a Streaming Interceptor Hook inside the production
local proxy layer: detect `[EXEC_REQUEST]` blocks emitted by ChatGPT mid-turn,
prompt a human for approval over a TTY, execute the approved command locally,
and feed `[EXEC_RESULT]` back into the same live turn — eliminating the need
for the OpenAI Tunnel / MCP connector in cases where this suffices.

`docs/superpowers/specs/2026-09-13-hil-dev-chat-design.md` implemented a first
version of this protocol scoped to the repository's own `dev chat` CLI
(`src/dev-chat/`), which drives the daemon as an HTTP client over
non-streaming, one-round-per-HTTP-call turns. That spec explicitly deferred
"production `browser-only` daemon integration" as a follow-on.

This spec is that follow-on: wiring the same `[EXEC_REQUEST]`/`[EXEC_RESULT]`
protocol into the actual production daemon that Codex talks to over
`/v1/responses` — the request-processing path runs through `src/server.ts`,
`src/bridge.ts`, and the `chatgpt-web` adapter (`src/adapters/chatgpt-web/`),
which streams a real, live browser turn back to Codex incrementally rather
than returning one complete round at a time. As detailed in §2, the changes
this spec actually makes are narrower than that whole path: `src/bridge.ts`
is unmodified, `src/server.ts` gains only startup-flag plumbing (§3) with its
request-processing/SSE logic untouched (§10), and the new surface lives in
`src/adapters/chatgpt-web/index.ts` and `browser-worker.ts`.

## 2. Why the production daemon is structurally different from `dev chat`

`DevChatDriver.send()` runs a bounded, non-streaming round loop: each round is
a complete HTTP round-trip, and HIL detection scans a round's already-finished
output text. The production path is the opposite: `responseRequest()`
(`src/server.ts:446`) starts streaming an SSE response back to Codex
(`src/server.ts:611-637`) before the browser turn finishes, via an
`AsyncEventQueue` of `AdapterEvent`s (`src/types.ts:186`) that
`bridgeToResponsesSSE()` (`src/bridge.ts:84`) turns into Responses-shaped SSE
chunks in real time. `text_delta` events arrive incrementally as the browser
worker observes them (`onTextDelta` in `src/adapters/chatgpt-web/index.ts`).

**A cross-invocation mechanism was considered and rejected.** `prepareResume`/
`retainConversation`/`conversationKey` (the tool-capable branch's pattern for
resuming a retained browser tab across a *new, separate* `runTurn()` call) looks
superficially reusable, but is not: session bookkeeping (`ChatGptTurnSessions`,
`src/adapters/chatgpt-web/turn-execution.ts`) binds exactly one browser runtime
per `executionKey` with no way to attach a second one; round journaling
(`appendRoundEvents`/`completeRound`, `turn-execution.ts:411-457`) is per-HTTP-call
and permanently freezes once a round completes; and `src/bridge.ts` (`:585-680`)
tears down the entire SSE/HTTP response the instant it sees the *first*
terminal (`done`/`error`/`incomplete`) event. An interceptor built around a
second, internally-triggered `worker.run()` call would therefore either crash
(appending to a completed round) or have its second call's events silently
dropped once the first call's `done` already closed the stream.

The mechanism that actually works stays entirely inside a single `worker.run()`
call, so round/session/bridge bookkeeping never sees more than one turn: it
extends `runBrowserTurn`'s own turn-completion decision inside
`src/adapters/chatgpt-web/browser-worker.ts` (§5), reusing that file's own
message-submission primitives (`attachPrompt`/`sendAttachedPrompt`, already
called more than once per turn by the existing multipart/Bigger-Context
staged-submission path) to inject the follow-up into the same open page
before the turn is allowed to finalize. This means `browser-worker.ts` is no
longer a non-goal for this feature — see §10.

## 3. Activation

- New daemon-level setting `hilEnabled: boolean` in `AppConfig` (`src/config.ts`),
  persisted the same way `mode` is, set via a new `--hil` startup flag on
  `src/cli.ts`/`src/server.ts` (parallel to the existing mode flags).
- HIL is honored only when **both** hold at daemon startup:
  1. `config.mode === "browser-only"` (never `full` — `full` mode's real
     MCP/tunnel tool calls are completely untouched by this feature, matching
     the dev-chat design's boundary).
  2. `process.stdin.isTTY` is true for the daemon process itself (the daemon
     was started attached to a terminal — a deliberate foreground launch, not
     the normal detached/headless operation Codex relies on day to day).
- If `--hil` is requested but either condition is false, the daemon logs a
  clear warning and runs with HIL disabled for the entire process — fail
  closed, decided once at startup, never ambiguous per-request. This
  satisfies the PRD's headless-safety constraint (§Phase 3: "if
  `!process.stdin.isTTY`, automatically fall back to rejection mode to
  prevent headless stalls") at the coarser daemon-process granularity, since
  the production daemon has no per-request terminal to check.

## 4. Shared protocol modules (moved, not duplicated)

`src/dev-chat/hil-protocol.ts`, `hil-approval.ts`, and `hil-exec.ts` move
verbatim to a new shared location `src/hil/` (`protocol.ts`, `approval.ts`,
`exec.ts`), with no behavior change. `src/dev-chat/` re-exports from `src/hil/`
so its existing driver/session/cli code and tests continue to work unmodified.
This is the only change to already-shipped dev-chat code, and it is a pure
move-and-re-export — no logic changes, no new tests required beyond
confirming the existing dev-chat test suite still passes after the move.

The production daemon integration consumes `src/hil/*` directly; it does not
depend on anything in `src/dev-chat/`.

## 5. The exec gate: a new `hilExecGate` hook in `browser-worker.ts`

`runBrowserTurn`'s completion loop (`browser-worker.ts:4774-5015`) already
decouples "the DOM looks finished" (`completionReady`, computed ~`:4912`) from
"actually finalize the turn": when a `completionFence` is present (today, only
for MCP tool-call race prevention), the loop calls `begin()`/`commit()` and
loops back with a 250ms sleep instead of finalizing if it declines. This spec
adds a second, parallel gate with the same shape but content-driven instead
of activity-driven:

```ts
// New field on the BrowserTurn interface (browser-worker.ts:1144-1149 area)
interface HilExecGate {
  /** Called once completionReady is true, before the turn would otherwise
   * finalize. `finalText` is the fully-settled, debounced text the
   * completion tracker just confirmed stable. */
  check(finalText: string): Promise<
    | { action: "finalize" }
    | { action: "resume"; followUpText: string }
  >;
}
// on BrowserTurn:
hilExecGate?: HilExecGate;
```

Inserted into `runBrowserTurn`'s loop immediately after `completionReady`
becomes true (and after any `completionFence` check, ~`:4912-4945`), before
`markdownBuffer.finish()`/`break` (~`:4949-4969`):

- `turn.hilExecGate` is only ever set when `config.hilEnabled` (§3); absent,
  behavior is byte-for-byte unchanged from today.
- `check(finalText)` returning `{ action: "finalize" }` proceeds exactly as
  today (no EXEC_REQUEST present, or the gate is not engaged).
- `{ action: "resume", followUpText }`: instead of finalizing, `runBrowserTurn`
  recaptures a submission baseline (`captureSubmissionBaseline`, the same call
  the multipart staged-submission path already makes per stage, `:4534`),
  calls `attachPromptWithCompactionRetry`/`sendAttachedPrompt` (`:4646-4719`,
  already safe to call more than once per turn — the multipart path proves
  this) to type and submit `followUpText` into the same open page, rebinds
  `waitForNewAssistantTurn` for the new assistant response, resets the
  `ChatGptCompletionTracker`/`ChatGptTurnDomHealthTracker` instances (fresh
  debounce windows for the new response), and loops back into DOM polling.
  The whole exchange — including any number of further EXEC_REQUEST rounds —
  stays inside this one `runBrowserTurn`/`worker.run()` call; `browser` does
  not resolve until a `check()` call finally returns `{ action: "finalize" }`.

**`HilExecGate.check`'s implementation** lives in a new, much smaller module,
`src/adapters/chatgpt-web/hil-interceptor.ts`:
`createHilExecGate(deps): HilExecGate`, where
`deps = { approvalGateway, runCommand: typeof runApprovedCommand, workspaceCwd }`
(all from `src/hil/*`, unchanged). `check(finalText)` calls
`parseExecRequest(finalText)` (`src/hil/protocol.ts`); on no match, returns
`{ action: "finalize" }`; on a match, calls
`runCommand(approvalGateway, request, workspaceCwd)` (`src/hil/exec.ts`,
already never-throws) and returns
`{ action: "resume", followUpText: <the resolved [EXEC_RESULT] block or
EXEC_REJECTED_TEXT> }`.

**Timeout/stall tolerance.** Two existing mechanisms would otherwise misfire
during the (unbounded) approval wait and (bounded, ≤60s) execution:
1. `turnTimeoutMs`'s deadline check (`:4364-4366`, `:4791-4793`) is a hard,
   no-grace `throw`. When `config.hilEnabled`, the adapter passes
   `turnTimeoutMs: undefined` for HIL-active turns (no deadline), matching how
   `dev chat` already sets an effectively unbounded timeout
   (`src/dev-chat/driver.ts:417`, one hour) for the same reason.
2. `ChatGptTurnDomHealthTracker`'s 60-second "text present, no completion
   action" and "response DOM missing" grace windows (`:1442-1519`) already
   have a suspension mechanism: `externalProgressLive` (`:1473-1480`)
   suppresses all three windows while MCP tool activity is recent. This spec
   reuses that same suspension signal — while `hilExecGate.check(...)` has an
   outstanding promise (from the moment `completionReady` first fires through
   resume-and-loop), the tracker is told activity is live via the same
   `externalProgressLive`-shaped signal, so its grace windows do not expire
   mid-approval. `ChatGptCompletionTracker`'s 2-second stability debounce is
   unaffected by this suspension — it already runs *before* `hilExecGate` is
   consulted, which is the correct order: text must be stable before the gate
   inspects it for a complete `[EXEC_REQUEST]` block.

## 6. Suppressing protocol text from Codex's transcript

Separately from the exec gate (which operates on debounced, complete text
inside `browser-worker.ts`), the daemon must not let the raw
`[EXEC_REQUEST]...[/EXEC_REQUEST]` block reach Codex as ordinary assistant
text — Codex only ever sees the human-facing conversation. A small filter
wraps `emit` in the `!mode.localTools` branch (`src/adapters/chatgpt-web/index.ts:672`)
only when `config.hilEnabled`: it accumulates `text_delta` text since the last
flush, and withholds forwarding once the accumulated text starts matching
`[EXEC_REQUEST` (prefix match); if the block later fails to close/parse, it
flushes the withheld text verbatim (ordinary output, not a real protocol
block); if it *does* parse as a complete `[EXEC_REQUEST]` (mirroring
`parseExecRequest`'s own criteria, so the two checks never disagree), the
withheld text is dropped rather than flushed, and delta forwarding resumes
normally once `hilExecGate`'s resume/finalize decision produces further
`onTextDelta` calls for the (real, human-facing) continuation. This filter is
pure text bookkeeping with no async waiting of its own — all approval/exec
timing lives in §5's `hilExecGate`, not here. When `config.hilEnabled` is
false, `emit` passes through unwrapped, exactly matching today's behavior.

`src/bridge.ts` is unmodified by this design. `src/adapters/chatgpt-web/browser-worker.ts`
is modified only as described in §5 (a new optional `hilExecGate` field and
loop branch, gated entirely behind its presence).

## 7. Execution mechanics

Identical to the dev-chat design, reusing `src/hil/exec.ts` unchanged:
`child_process.spawn(command, { cwd, shell: true, timeout: 60_000 })`,
combined stdout+stderr truncated to 10KB, cwd resolved against the daemon's
own workspace root with pre-approval rejection for any path that escapes it,
timeout reported as a synthetic non-zero exit.

## 8. CLI/UX

- `src/cli.ts` / `src/server.ts`: new `--hil` startup flag, help text update,
  refused (with a clear error, not a silent downgrade) when combined with
  `--mode full`.
- The daemon logs the interceptor's approval prompts to its own attached
  terminal (the same `TtyApprovalGateway` UI from the dev-chat prototype,
  reused via `src/hil/approval.ts`) — this is the terminal the operator
  attached when starting the daemon in foreground/`--hil` mode, not Codex's
  own UI.
- No launcher/Electron UI approval surface in this spec (same non-goal as the
  dev-chat design; the `ApprovalGateway` interface remains the extension
  point for one).

## 9. Testing

- `src/hil/*`: move existing `src/dev-chat/hil-*.test.ts` files to
  `tests/hil-*.test.ts` unchanged (import paths updated), plus a
  `tests/dev-chat.test.ts` regression pass to confirm the re-export move
  didn't change dev-chat's own behavior.
- `tests/hil-exec-gate.test.ts` (new): drive `createHilExecGate(...).check(text)`
  directly with injected fake `approvalGateway`/`runCommand`, asserting: no
  match returns `{ action: "finalize" }`; a well-formed block returns
  `{ action: "resume", followUpText }` with the exact approve/run or reject
  formatting from `src/hil/*` (unchanged, already covered by their own tests —
  this test only checks the gate's own translation into `HilExecGate`'s
  return shape).
- `tests/hil-emit-filter.test.ts` (new): drive the §6 emit-wrapping filter
  with a scripted sequence of fake `text_delta`s, asserting the exact
  forwarded sequence for: clean passthrough (no `[` at all), a `[`-prefixed
  delta that turns out not to match (flush verbatim), and a delta sequence
  that completes a real `[EXEC_REQUEST]` block (withheld, never flushed).
- `tests/browser-worker-hil-gate.test.ts` (new, extending the existing
  `browser-worker-contract.test.ts` test-double harness): exercises
  `runBrowserTurn`'s new loop branch directly — a `hilExecGate` that returns
  `resume` once then `finalize`, asserting `attachPrompt`/`sendAttachedPrompt`
  are invoked a second time with the follow-up text, `waitForNewAssistantTurn`
  is rebound, and the turn's final `browser` promise resolves only after the
  second `finalize`. A second case confirms `turnTimeoutMs`'s deadline check
  does not fire during a simulated long approval wait, and a third confirms
  `ChatGptTurnDomHealthTracker`'s grace windows do not expire while
  `hilExecGate.check(...)` is pending.
- One test extending the existing `chatgpt-web` adapter test suite exercising
  `index.ts`'s `!mode.localTools` branch with `hilEnabled: true`, using a fake
  browser-worker double: confirms `turn.hilExecGate` is wired to
  `createHilExecGate(...)` and `turnTimeoutMs` is passed as `undefined`.
- No changes to `bridge.ts`'s own test suite, since that file is unmodified.
  `browser-worker-contract.test.ts` itself is unmodified — the new coverage
  lives in the new `browser-worker-hil-gate.test.ts` file to keep the new
  surface's tests isolated from the existing large contract suite.

## 10. Non-goals

- No changes to `src/server.ts`'s request-processing/SSE logic beyond the
  new `--hil` startup flag plumbing (§3, §8); no changes at all to
  `src/bridge.ts`, round/session journaling
  (`src/adapters/chatgpt-web/turn-execution.ts`), or the existing
  `prepareResume`/`retainConversation`/`completionFence` mechanisms — this
  design adds a new, independent `hilExecGate` hook alongside them rather
  than reusing or modifying them.
- `src/adapters/chatgpt-web/browser-worker.ts` gains exactly one new optional
  field (`hilExecGate` on `BrowserTurn`) and one new loop branch gated behind
  it (§5); every other line of that file's behavior is unchanged when
  `hilExecGate` is absent, which is the case for every non-HIL turn (all of
  `full` mode, and any `browser-only` turn without `--hil`).
- No change to `full` mode, the MCP connector, or the OpenAI Tunnel — HIL
  remains exclusively a `browser-only`-mode feature (per the approved scope
  decision; the PRD's framing of HIL as a full tunnel/MCP replacement is
  explicitly out of scope here).
- No Electron/launcher UI approval surface (interface left ready for one, as
  in the dev-chat design).
- No support for HIL in a detached/headless daemon process — activation
  requires an attached TTY at daemon startup; there is no per-request
  terminal to fall back to.
- No changes to the dev-chat CLI's own behavior beyond importing shared
  protocol/approval/exec modules from their new `src/hil/` location.
