# Design: HITL Local Exec Over the Launcher Browser Host

## 1. Context & Objective

`docs/hitl_prd.md` and `docs/superpowers/specs/2026-09-13-hitl-daemon-integration-design.md`
wired `[EXEC_REQUEST]`/`[EXEC_RESULT]` human-in-the-loop local exec into the
production `chatgpt-web` adapter, but scoped it to `browserHost: "managed-chrome"`
only. Two independent guards enforce that scope today:

1. `src/adapters/chatgpt-web/index.ts:371-380` — `createChatGptWebAdapter` throws
   at construction time if `hitlEnabled` and `browserHost === "launcher"` are both
   set.
2. `src/adapters/chatgpt-web/launcher-helper-client.ts:211-221` —
   `LauncherBrowserHelperClient.run()` throws if the `BrowserTurn` it receives
   carries a `hitlExecGate`, because the run frame sent to the helper child
   process is an explicit JSON field whitelist that cannot carry a live
   JavaScript callback object across the process boundary.

Separately, `src/setup.ts:419-425` restricts the CLI's *standalone* managed-Chrome
setup path to macOS only — non-macOS users who want the terminal-only CLI must
use `browserHost: "launcher"` (the desktop launcher owns the browser). Combined,
this means HITL is currently **unreachable on Linux and Windows**: the only
browser host available to them there (`launcher`) is the one HITL explicitly
refuses.

**Objective:** make `hitlExecGate` work over the launcher browser host, so
`codex-chatgpt-web serve --hitl` works with `browserHost: "launcher"` on any
platform, without touching the macOS-only managed-Chrome setup restriction
(out of scope — orthogonal problem, not addressed here).

## 2. Why this is safe to add: the completion-fence precedent

The launcher browser host runs the actual DOM-automation loop
(`ChatGptBrowserWorker.run`/`runBrowserTurn`, `browser-worker.ts`) inside a
separate child process (`browser-helper-main.ts`), driven by
`LauncherBrowserHelperClient` (`launcher-helper-client.ts`) in the daemon over a
newline-delimited JSON protocol on the child's stdio. Anything that needs to
"pause mid-turn, ask the daemon process a question, resume with an answer"
already has a working pattern on this exact channel: `completion_fence_begin`/
`completion_fence_begin_ack` and `completion_fence_commit`/
`completion_fence_commit_ack` (used for the MCP tool-call completion race), plus
`multipart_stage_acknowledged` and `send_activated`/`send_activation_ack`. Each
follows the same shape:

- The child (`browser-helper-main.ts`) constructs a small promise-based waiter,
  writes an `{ type: "event", ... }` frame, and awaits an ack frame to resolve
  it.
- The daemon (`launcher-helper-client.ts`) receives the event in `handleLine()`,
  performs the actual (possibly async) work using state that only it has
  (broker connections, in this case the TTY), and writes the ack frame back.
- Both sides advertise/require support for the frame via a `features` string in
  the helper's `ready` message, so an old helper build fails loudly instead of
  silently dropping something.

HITL's `hitlExecGate.check(finalText, abortSignal)` is structurally identical:
the daemon already owns the one piece of state that can't cross the IPC
boundary today — not because the *data* can't cross, but because the existing
design passes a **live callback object** (`hitlExecGate`) instead of an event.
Wrapping that same call in the same event/ack shape removes the obstacle
without changing what the call does.

**Consequence:** `src/adapters/chatgpt-web/index.ts` and
`src/adapters/chatgpt-web/browser-worker.ts` require **no changes**.
`worker.run(turn)` already forwards the whole `BrowserTurn` — `hitlExecGate`
included — into `LauncherBrowserHelperClient.run(turn)` unmodified; only that
one method currently refuses it. `browser-worker.ts`'s completion loop already
calls `turn.hitlExecGate.check(finalText, turn.abortSignal)` through the
`HitlExecGate` *interface* — it has no idea whether the concrete
implementation runs the approval gateway locally (managed-chrome) or proxies
it over IPC (launcher). The daemon-side `check()` logic itself
(`createHitlExecGate` in `src/adapters/chatgpt-web/hitl-interceptor.ts`,
including its abort-signal re-checks and the `HitlApprovalQueue` that
serializes concurrent turns' TTY prompts onto the daemon's one stdin) is
reused completely unmodified — it is simply invoked from a new event handler
instead of directly inline.

## 3. Protocol addition

Two new message shapes on the existing helper protocol:

```ts
// Child -> Daemon (new HelperMessage variant)
{ type: "event", id: string, event: "hitl_exec_request", requestId: number, text: string }

// Daemon -> Child (new outbound message type)
{ type: "hitl_exec_result_ack", id: string, requestId: number, action: "finalize" }
{ type: "hitl_exec_result_ack", id: string, requestId: number, action: "resume", followUpText: string }
```

`text` carries the fully-settled, debounced DOM text exactly as
`browser-worker.ts` already passes it to `hitlExecGate.check()` today — the
child does no `[EXEC_REQUEST]` parsing itself; `parseExecRequest` continues to
run exactly once, daemon-side, inside the reused `createHitlExecGate` logic.

Feature negotiation: the helper's `ready` message
(`browser-helper-main.ts:520`) adds `"hitl-exec-gate"` to its `features` array,
alongside the existing `"progress"`, `"tool-boundary-ack"`,
`"completion-fence"`, `"multipart-stage-ack"`.

## 4. Component changes

### `src/adapters/chatgpt-web/index.ts`

Delete the guard at lines 371-380
(`if (hitlActive && provider.chatgptWeb?.browserHost === "launcher") throw ...`).
No other change in this file — `hitlExecGate` construction at line 736-741 is
already browser-host-agnostic.

### `src/adapters/chatgpt-web/launcher-helper-client.ts`

- `HelperMessage` union: add the `hitl_exec_request` event variant.
- `parseHelperMessage`: validate `requestId` (positive safe integer) and `text`
  (string), same strictness as the existing event variants (e.g.
  `completion_fence_begin`'s `requestId` check).
- `run()`: replace the unconditional throw (`turn.hitlExecGate` present ⇒
  refuse) with:
  ```ts
  if (turn.hitlExecGate && !this.helperFeatures.has("hitl-exec-gate")) {
    throw new Error(
      "Launcher browser helper does not support human-in-the-loop local exec; update or restart the launcher",
    );
  }
  ```
  and include `hitl: Boolean(turn.hitlExecGate)` in the `run` frame's `turn`
  payload sent to the child (mirrors how `externalProgress`/`compaction`/etc.
  become boolean flags on that frame today).
- `handleLine()`: new `else if (message.event === "hitl_exec_request")` branch,
  mirroring the `completion_fence_begin` branch:
  ```ts
  else if (message.event === "hitl_exec_request") {
    const gate = pending.turn.hitlExecGate;
    if (!gate) {
      this.abortWithLocalFailure(
        message.id,
        new Error("Launcher browser helper requested HITL exec for a turn without a gate"),
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

### `src/adapters/chatgpt-web/browser-helper-main.ts`

- `RunMessage.turn.hitl?: boolean`, validated alongside the other boolean-flag
  fields in `run()`.
- New `hitlExecWaiters = new Map<string, { requestId; resolve; reject }>()`
  (same shape as `completionFenceBeginWaiters`), declared alongside the other
  waiter maps.
- In `run()`'s turn construction, when `message.turn.hitl`:
  ```ts
  hitlExecGate: {
    check: finalText => new Promise<{ action: "finalize" } | { action: "resume"; followUpText: string }>((resolve, reject) => {
      if (hitlExecWaiters.has(message.id)) {
        reject(new Error("Browser helper HITL exec gate already awaits a result"));
        return;
      }
      completionFenceRequestId += 1; // shared monotonic id source; renamed if this reads oddly in review
      const requestId = completionFenceRequestId;
      hitlExecWaiters.set(message.id, { requestId, resolve, reject });
      if (!writeProtocol({ type: "event", id: message.id, event: "hitl_exec_request", requestId, text: finalText })) {
        hitlExecWaiters.delete(message.id);
        reject(new Error("Browser helper could not request HITL exec approval"));
      }
    }),
  }
  ```
  (Implementation detail to settle during planning: whether this reuses the
  existing `completionFenceRequestId` counter or gets its own — either is
  correct since request ids only need to be unique per in-flight wait on a
  given turn id; planning should pick whichever reads more clearly next to the
  existing code.)
- New `hitl_exec_result_ack` branch in the child's incoming-message dispatch
  (mirrors `completion_fence_begin_ack`): validate `action` is `"finalize"` or
  `"resume"` (+ `followUpText: string` when `"resume"`), resolve the matching
  waiter, delete it from the map.
- Cleanup: reject any pending `hitlExecWaiters` entry in both the `abort`
  message handler and `run()`'s `finally` block, same pattern and wording as
  the existing `completionFenceBeginWaiters`/`completionFenceCommitWaiters`
  cleanup.
- Add `"hitl-exec-gate"` to the `features` array in the `ready` message
  (`browser-helper-main.ts:520`).

## 5. Error handling

- **Old launcher build (no `hitl-exec-gate` feature):** the daemon throws
  before ever spawning/dispatching the turn — same fail-closed posture the
  current blanket guard has today, just gated on an advertised capability
  instead of the browser host name. Message text mirrors the existing
  `multipart-stage-ack`/`tool-boundary-ack` phrasing ("update or restart the
  launcher").
- **Turn aborted mid-approval** (Codex cancels while the TTY approval prompt
  is open): `createHitlExecGate`'s existing `check()` implementation
  (`hitl-interceptor.ts:22-48`) already re-checks `abortSignal.aborted` both
  before prompting and after the decision settles, and never spawns a command
  for a dead turn — completely unchanged by this work, since it's invoked the
  same way, just from a new call site. On the wire, if the daemon's
  `pending.turn.abortSignal` fires while `gate.check()` is in flight, the
  existing `pending.localFailure`/`abortSignal?.aborted` guard in the `.then()`
  callback (identical to the completion-fence handlers) prevents a stale ack
  from being sent. Child-side, `hitlExecWaiters` entries are rejected on
  `abort`/shutdown exactly like `completionFenceBeginWaiters`.
- **Malformed protocol frames:** `parseHelperMessage` validates the new event
  the same way it validates every other one; invalid data crashes the
  connection via the existing `handleExit` + terminate path (deliberately
  unchanged — this is how every other protocol violation is handled today).

## 6. Testing

- `tests/chatgpt-web-hitl-wiring.test.ts` ("Finding 2" tests):
  - `createChatGptWebAdapter refuses HITL when the browser host is the launcher`
    → flip to assert construction **succeeds** (no throw) for that
    combination.
  - `the launcher helper client refuses a BrowserTurn carrying a hitlExecGate`
    → keep, but scope it to "refuses when the helper hasn't advertised
    `hitl-exec-gate`"; add a sibling test asserting `run()` succeeds (and
    sends `hitl: true` in the frame) once `helperFeatures` includes it.
- `tests/launcher-helper-client.test.ts`: extend the existing real-child-process
  test (it already spawns actual `browser-helper-main.ts` via `bun` and
  monkeypatches `ChatGptBrowserWorker.prototype.run`, exercising the true wire
  protocol, not mocks) with a case whose fake `run` calls
  `turn.hitlExecGate!.check(text)` and asserts the full round trip for both
  the `finalize` and `resume` outcomes, including that a `resume` result's
  `followUpText` reaches the fake `run`'s continuation.
- New unit coverage for `parseHelperMessage`'s `hitl_exec_request` validation
  (rejects non-positive `requestId`, non-string `text`), placed next to the
  existing sibling-event validation tests.
- No existing managed-chrome HITL test in `tests/chatgpt-web-hitl-wiring.test.ts`
  or `tests/dev-chat-*.test.ts` changes — this work is purely additive on the
  launcher path.

## 7. Explicitly out of scope

- Any launcher (Electron/renderer) UI for toggling HITL — confirmed out of
  scope with the user; this is CLI-flag-only, same as managed-chrome HITL
  today.
- Lifting the macOS-only restriction on standalone managed-Chrome CLI setup
  (`src/setup.ts:419-425`) — orthogonal; this design makes the *launcher* host
  work with HITL, it does not touch managed-Chrome setup availability.
- Any change to `docs/hitl_prd.md`'s protocol contract
  (`[EXEC_REQUEST]`/`[EXEC_RESULT]` text format) — unchanged.
