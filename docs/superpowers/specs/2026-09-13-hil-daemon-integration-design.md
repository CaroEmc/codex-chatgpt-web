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
`/v1/responses` — `src/server.ts`, `src/bridge.ts`, and the `chatgpt-web`
adapter (`src/adapters/chatgpt-web/`), which streams a real, live browser turn
back to Codex incrementally rather than returning one complete round at a
time.

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

There is also no existing way to inject an arbitrary follow-up message into a
still-open browser turn without a new Codex-initiated HTTP request — except
one precedent: the tool-capable (`mode.localTools`) branch of `runTurn`
(`src/adapters/chatgpt-web/index.ts`, around line 730) already passes
`prepareResume` to `worker.run(...)`, letting a turn continue across a tool
round-trip while staying on the same live browser session. The browser-only
branch (`!mode.localTools`, `index.ts:672`) has no `prepareResume` today. This
design extends that existing, already-proven pattern into the browser-only
branch rather than inventing a new mechanism.

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

## 5. The interceptor: `src/adapters/chatgpt-web/hil-interceptor.ts`

New module, `createHilInterceptor(realEmit, deps): { emit, onAbort }`:

```ts
interface HilInterceptorDeps {
  approvalGateway: ApprovalGateway; // from src/hil/approval.ts
  runCommand: typeof runApprovedCommand; // from src/hil/exec.ts, injected for testability
  workspaceCwd: string;
  requestResume: (resultText: string) => void; // calls worker.run's prepareResume
  abortSignal: AbortSignal; // the turn's existing browserAbort.signal
}
```

`createHilInterceptor` wraps the `emit` callback passed to `runTurn`
(`src/adapters/base.ts:14`) only when `config.hilEnabled` is true for a
browser-only turn. It runs a three-state machine over `text_delta` events,
mirroring the PRD §3.2 buffer but built for the daemon's real event stream
rather than raw SSE bytes:

- **PASSTHROUGH** (default): every `AdapterEvent` is forwarded to `realEmit`
  unchanged. A `text_delta` whose text contains the literal prefix `[` is
  inspected further; everything else (tool events, heartbeats, `done`, etc.)
  always passes straight through in every state.
- **BUFFERING**: entered when accumulated `text_delta` text since the last
  flush point starts matching `[EXEC_REQUEST`. Withholds forwarding until
  either (a) `parseExecRequest` (from `src/hil/protocol.ts`) succeeds against
  the accumulated text — proceed to PENDING_APPROVAL — or (b) the accumulated
  text diverges from a possible match (extra non-matching content, or a
  `done` event arrives first) — flush all withheld text verbatim to
  `realEmit` and return to PASSTHROUGH. This mirrors the PRD's "parsing fails
  or the block does not match the schema" fallback.
- **PENDING_APPROVAL**: entered once `parseExecRequest` returns a well-formed
  request. The interceptor:
  1. Emits a `heartbeat` event on a fixed interval (reusing the `AdapterEvent`
     type already used elsewhere for keep-alives, e.g. `index.ts:1420`) so the
     open SSE connection to Codex does not idle out while awaiting approval.
  2. Calls `deps.runCommand(deps.approvalGateway, request, deps.workspaceCwd)`
     — the exact same `src/hil/exec.ts` function the dev-chat prototype uses,
     unchanged. This always resolves (never throws) to either a formatted
     `[EXEC_RESULT]` block or `EXEC_REJECTED_TEXT`.
  3. Calls `deps.requestResume(resultText)`, which the adapter wires to
     `worker.run`'s new `prepareResume` callback (§6) to continue the same
     live browser turn.
  4. Resets to PASSTHROUGH so the resumed turn's subsequent deltas flow
     through normally.

If `deps.abortSignal` fires while in PENDING_APPROVAL (Codex disconnected, or
the browser turn was cancelled for any other reason), the interceptor stops
waiting on the approval gateway's result — it does not call
`requestResume` (the turn is already gone) and does not throw. `runCommand`'s
own promise is not force-cancelled (a running command finishes on its own
timeout); its result is simply discarded once the signal fires.

## 6. Wiring into `index.ts`

In the `!mode.localTools` branch (`src/adapters/chatgpt-web/index.ts:672`),
when `config.hilEnabled`:

- Wrap `emit` via `createHilInterceptor(emit, { ...deps })` before it reaches
  `worker.run`'s `onTextDelta`/other callbacks — i.e., the interceptor sits
  between the adapter's own event construction and the real `emit` the bridge
  observes.
- Add a `prepareResume` callback to the `worker.run({...})` call at
  `index.ts:672-700`, mirroring the tool-capable branch's existing
  `prepareResume` (`index.ts:~730`): given the interceptor's result text, it
  builds a `CodexParsedRequest`-shaped follow-up input the same way
  `prepareWith`/`compileChatGptWebPrompt` already does for a resumed turn, and
  `worker.run` submits it into the same open browser session.
- When `config.hilEnabled` is false (the common case — headless daemon,
  `full` mode, or HIL not requested), `emit` passes through unwrapped and
  `prepareResume` is omitted, exactly matching today's behavior. This is the
  only conditional; no other code path changes.

`src/bridge.ts` and `src/adapters/chatgpt-web/browser-worker.ts` are
unmodified by this design.

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
- `tests/hil-interceptor.test.ts` (new): drive `createHilInterceptor` with a
  scripted sequence of fake `AdapterEvent`s and injected fake
  `approvalGateway`/`runCommand`/`requestResume`, asserting the exact emitted
  sequence for: clean passthrough (no `[` at all), a `[`-prefixed delta that
  turns out not to match (flush), a full approve→run→resume cycle, a reject
  cycle, and an abort-signal-during-PENDING_APPROVAL case (no `requestResume`
  call).
- One test extending the existing `chatgpt-web` adapter test suite (using its
  existing browser-worker test double, e.g. patterns from
  `tests/browser-worker-contract.test.ts`) exercising `index.ts`'s
  `!mode.localTools` branch with `hilEnabled: true`: confirms `prepareResume`
  is invoked with the interceptor's formatted result text and that the
  turn's final `done` event still reaches the bridge.
- No changes to `bridge.ts`'s or `browser-worker.ts`'s own test suites, since
  neither file changes.

## 10. Non-goals

- No changes to `src/bridge.ts` or `src/adapters/chatgpt-web/browser-worker.ts`.
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
