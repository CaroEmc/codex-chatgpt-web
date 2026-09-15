# HITL Interactive Popup Approval — Design Spec

## Context

`codex-chatgpt-web serve --hitl` intercepts a ChatGPT Web model's `[EXEC_REQUEST]`
protocol block and prompts for approval on the daemon's own terminal
(`TtyApprovalGateway` in `src/hitl/approval.ts`). A prior change
(`src/adapters/chatgpt-web/hitl-desktop-notify.ts`) added a best-effort desktop
notification, over the launcher's control channel, that nudges the operator back
toward that terminal — but it carries no decision of its own, and on Linux the
notification has no interactive action buttons at all (Electron only supports
notification actions on macOS).

This spec replaces that plain nudge with a real interactive approval surface: a
small popup window opened by the desktop launcher, usable identically on Linux,
macOS, and Windows, that can supply the actual approval decision.

## Goals

- When the browser host is the launcher, a HITL approval prompt can be answered
  either from the daemon's terminal (unchanged) or from a popup window the
  launcher opens — whichever the operator answers first wins.
- The popup offers full parity with the terminal prompt: view the reason,
  directory, and command; edit the command inline; Run or Reject.
- Whichever side does *not* answer is actively cancelled (terminal prompt closes;
  popup window closes) rather than left stale.
- If the launcher is unreachable, closed, or errors, HITL keeps working exactly
  as it does today — terminal-only, no regression.

## Out of scope

- Native OS notification action buttons (macOS-only in Electron; superseded by
  the popup for a consistent cross-platform experience).
- Any change to `src/hitl/exec.ts` or how an approved command is actually run —
  the popup only ever produces the same `ApprovalDecision` shape the terminal
  already produces.
- Support for `browserHost: "managed-chrome"` — there is no launcher process to
  ask for a popup in that mode; behavior there is unchanged (terminal-only).

## Architecture

```
createHitlExecGate → HitlApprovalQueue.forTurn(traceId) → [racing gateway]
                                                              ├─ TtyApprovalGateway (terminal)
                                                              └─ launcher popup (control channel)
```

The racing gateway (`withDesktopApproval`, replacing today's
`withDesktopNotify`) starts both competitors concurrently on every
`request(proposal, signal)` call, under one internal `AbortController`:

- **Terminal**: the existing `TtyApprovalGateway`, unchanged, given a signal that
  is aborted if the popup wins.
- **Popup**: a new bounded long-poll client, `requestLauncherHitlDecision`,
  given a signal that is aborted if the terminal wins (or the turn is
  cancelled).

`Promise.race` on the two returns whichever settles first; the internal
controller is then aborted so the loser is cancelled. The popup path is
designed to never reject on its own (launcher errors) — only to never resolve —
so the terminal always remains authoritative when the launcher can't help.

## Components

### 1. `launcher/electron/control-server.cjs` — new endpoints

This replaces the earlier `POST /v1/notify/hitl-pending` endpoint and its
`notifyHitlApprovalPending` main-process function entirely (removed, not left
alongside the new ones) — the popup is strictly more capable than the plain
nudge it supersedes.

`POST /v1/hitl/decide` (token-authenticated like every other route in this
file). Body: `{ traceId, command, cwd, reason }` (reason optional). Follows the
exact bounded long-poll pattern already used by `/v1/manual/wait-sent` /
`/v1/manual/wait-terminal`:

- On the *first* call for a given `traceId`, tells the browser host (via a new
  `getBrowserHost()`-independent hook — see below) to open the popup, then waits
  up to `HITL_DECIDE_OBSERVER_TIMEOUT_MS` (35\_000, matching the existing manual
  timeout constant) for a decision.
- If no decision lands within the timeout, responds `202 { status: "pending" }`
  — the client loops and calls again (identical contract to
  `waitForLauncherManualSent`). The popup stays open across polls; only the
  HTTP leg times out and re-establishes.
- If the client disconnects mid-wait (`request.on("close")`), the popup for
  that `traceId` is closed immediately — this is how the terminal winning the
  race cancels the popup.
- On a decision, responds `200 { ok: true, action: "run", command }` or
  `200 { ok: true, action: "reject" }`, and the popup window closes.

`POST /v1/hitl/decide/cancel` (same auth): body `{ traceId }`. Calls
`hitlApproval.cancel(traceId)`, closing that `traceId`'s popup if it's still
open. Always responds `200 { ok: true }`, even if there was nothing to cancel
(the terminal-won-the-race path calls this unconditionally as a best-effort
cleanup — see component 5).

Neither endpoint goes through `getBrowserHost()` at all (unlike every other
route in this file) — it has nothing to do with the ChatGPT browser session,
only with opening a small independent window. It is wired directly to a new
`notifyHitlApprovalPending`-shaped dependency passed into `BrowserControlServer`'s
constructor, renamed/extended to a small controller object:

```js
new BrowserControlServer({
  logger,
  getBrowserHost: () => browserHost,
  getPreferences: () => stateStore.read(),
  hitlApproval: {
    requestDecision(traceId, proposal) { /* opens/reuses the popup, returns a promise */ },
    waitForDecision(traceId, timeoutMs) { /* the bounded wait, mirrors waitManualSent's shape */ },
    cancel(traceId) { /* closes the popup for traceId if still open */ },
  },
}).start();
```

### 2. `launcher/electron/hitl-popup.cjs` (new) — main-process popup controller

Owns the popup `BrowserWindow` lifecycle and the pending-decision bookkeeping,
keyed by `traceId` (mirrors `manualTerminalSignals`/`turnTabs` bookkeeping
already in `browser-host.cjs`, but intentionally kept in its own small module —
this has nothing to do with the ChatGPT browser session or `BrowserHost`).

- `requestDecision(traceId, proposal)`: if a popup for `traceId` is already
  open (a re-poll after a timeout), no-op. Otherwise creates a small
  `BrowserWindow` (`width: 420, height: 260`, `alwaysOnTop: true`, `frame:
  true`, `resizable: false`, its own dedicated `preload: hitl-popup-preload.cjs`,
  `webPreferences: { contextIsolation: true, nodeIntegration: false }`), loads
  a small bundled HTML page (`hitl-popup.html`, new file under
  `launcher/electron/`), and sends the proposal to it via
  `webContents.send("hitl-popup:proposal", proposal)` once `did-finish-load`
  fires. Registers an internal pending-decision `Promise` for `traceId`.
- `waitForDecision(traceId, timeoutMs)`: returns the pending promise, raced
  against a timeout that resolves to a `"pending"` sentinel (never rejects) —
  the control-server endpoint above translates that sentinel into the `202`
  response.
- The popup's `ipcMain.handle("hitl-popup:respond", ...)` resolves that
  `traceId`'s pending promise with the decision the renderer sent, then closes
  the window.
- The popup's `window.on("closed", ...)` (covers the operator clicking the OS
  close button) resolves the pending promise with `{ action: "reject" }` if it
  hasn't already resolved — fail-closed, matching `TtyApprovalGateway`'s own
  "unrecognized input rejects" posture.
- `cancel(traceId)`: if a popup is still open for `traceId` (the terminal won
  the race), closes it — its own `closed` handler then resolves the
  already-abandoned pending promise, which is harmless since nothing is still
  awaiting it.

### 3. `launcher/electron/hitl-popup.html` + `hitl-popup-preload.cjs` (new)

A minimal static page: reason/dir shown as read-only text, command shown in a
single-line `<input>` pre-filled with the proposed command, two buttons ("Run"
default-focused, "Reject"). All proposal text is set via `textContent`/`.value`
from data received over `ipcRenderer.on("hitl-popup:proposal", ...)` — never
templated into HTML — so a model-controlled command/reason string (untrusted
text, effectively attacker-controlled if a session were ever compromised) can't
inject markup or script. `contextBridge` exposes only
`onProposal(callback)` and `respond(decision)`; no other Electron/Node API is
reachable from this page.

### 4. `src/launcher-browser-host.ts` — new client

```ts
export const LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS = 40_000; // > server's 35s wait

export async function requestLauncherHitlDecision(
  descriptorPath: string,
  proposal: { traceId: string; command: string; cwd: string; reason?: string },
  signal?: AbortSignal,
): Promise<{ action: "run"; command: string } | { action: "reject" }> {
  for (;;) {
    if (signal?.aborted) return new Promise(() => {}); // never resolves; caller already lost the race
    let response: Response;
    try {
      const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(`${descriptor.control.endpoint}/v1/hitl/decide`, {
          method: "POST",
          headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
          body: JSON.stringify(proposal),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    } catch {
      return new Promise(() => {}); // launcher unreachable/aborted: never resolves, terminal stays authoritative
    }
    if (response.status === 202) continue; // still pending, loop
    if (!response.ok) return new Promise(() => {});
    const body = await response.json().catch(() => undefined) as
      | { ok: true; action: "run"; command: string }
      | { ok: true; action: "reject" }
      | undefined;
    if (!body?.ok) return new Promise(() => {});
    return body.action === "run" ? { action: "run", command: body.command } : { action: "reject" };
  }
}
```

This mirrors `waitForLauncherManualSent`'s loop shape exactly, with one
deliberate difference: every failure path resolves a promise that never
settles rather than throwing — this function must never be the reason the race
picks a bad outcome; its only two valid outcomes are "the popup produced a real
decision" or "silently defer to the terminal".

### 5. `src/adapters/chatgpt-web/hitl-desktop-approval.ts` (renamed from
`hitl-desktop-notify.ts`) — the racing wrapper

```ts
export function withDesktopApproval(gateway: ApprovalGateway, descriptorPath: string): ApprovalGateway {
  return {
    async request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
      const race = new AbortController();
      const onOuterAbort = () => race.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      const traceId = proposal.traceId ?? "untraced";
      try {
        const winner = await Promise.race([
          gateway.request(proposal, race.signal),
          requestLauncherHitlDecision(descriptorPath, { traceId, command: proposal.command, cwd: proposal.cwd, reason: proposal.reason }, race.signal),
        ]);
        return winner;
      } finally {
        race.abort();
        signal?.removeEventListener("abort", onOuterAbort);
        void notifyLauncherHitlCancelled(descriptorPath, traceId); // best-effort: closes a still-open popup if the terminal won
      }
    },
  };
}
```

`notifyLauncherHitlCancelled` (new, alongside `requestLauncherHitlDecision` in
`src/launcher-browser-host.ts`) is a tiny best-effort fire-and-forget POST to
`/v1/hitl/decide/cancel` — needed because aborting the *client's* fetch
only closes that one in-flight poll; if the popup is mid-open between polls
when the terminal wins, this is what actually closes it. (The `race.abort()`
call also aborts the terminal side symmetrically when the popup wins — no
separate cancel call is needed for that direction, since
`TtyApprovalGateway.request` already closes its own reader on abort.)

### 6. `index.ts` wiring

Same trigger condition as today — `retainedLauncherDescriptor` truthy (i.e.
`browserHost === "launcher"` with a configured descriptor path). Swap the
`withDesktopNotify` import/call for `withDesktopApproval`.

## Error handling summary

| Situation | Behavior |
|---|---|
| Launcher not running / unreachable | Popup side never resolves; terminal is the only prompt, exactly as today. |
| Launcher running, popup opened, operator answers in terminal first | Terminal's decision wins; popup is closed via the cancel call. |
| Launcher running, operator answers in popup first | Popup's decision wins; terminal's readline closes (existing abort-driven behavior in `TtyApprovalGateway`). |
| Operator closes the popup window (X button) without choosing | Treated as reject, fail-closed — but only wins the race if it happens before the terminal answers. |
| Turn is cancelled (Codex/browser aborts) while both are open | Outer `signal` abort tears down both; command never runs (unchanged from today's single-gateway abort behavior). |
| Multiple concurrent HITL turns | `HitlApprovalQueue` still serializes everything onto one flow; only one popup and one terminal prompt are ever live at once. |

## Testing plan

- `launcher/tests/control-server.test.cjs`: new tests for `/v1/hitl/decide` —
  pending→decision round trip (mocked `hitlApproval`), disconnect calls
  `cancel`, malformed body rejected.
- New `launcher/tests/hitl-popup.test.cjs`: `requestDecision`/`waitForDecision`/
  `cancel` lifecycle against a stubbed `BrowserWindow` (this repo already stubs
  Electron modules for `.cjs` unit tests elsewhere — follow that pattern),
  including the "window closed without a decision → reject" path.
- `tests/launcher-browser-host.test.ts`: `requestLauncherHitlDecision` —
  pending-then-decided round trip, never-resolves on network error, never-
  resolves when the passed signal is already aborted.
- New `tests/hitl-desktop-approval.test.ts` (replacing
  `hitl-desktop-notify.test.ts`): fake terminal gateway vs. fake popup gateway,
  proving (a) terminal-wins cancels the popum path and returns the terminal's
  decision, (b) popup-wins aborts the terminal's signal and returns the
  popup's decision, (c) popup-unreachable still returns the terminal's
  decision (regression guard for the "never resolves" contract), (d) a
  terminal win fires the best-effort cancel call.
- Manual smoke test (documented, not automated): with the CLI's `--hitl`
  daemon running and the launcher open, trigger a real `[EXEC_REQUEST]` and
  confirm the popup appears, editing the command field changes what runs, and
  Reject correctly declines.

## Global constraints carried into the implementation plan

- Popup content is set via `textContent`/`.value` only — never HTML-templated
  from proposal text (XSS guard against model-controlled text).
- The popup's `webContents` must have `contextIsolation: true`,
  `nodeIntegration: false`, and its own minimal preload — never the main app's
  full `preload.cjs`.
- `requestLauncherHitlDecision` and the racing wrapper's failure paths must
  never *reject* — only ever resolve-late or never-resolve — so a broken
  launcher can never accidentally win the race with a bad outcome.
- `HITL_DECIDE_OBSERVER_TIMEOUT_MS` (server) must stay below
  `LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS` (client), matching the existing
  manual-turn constants' relationship, so the client's own fetch never times
  out before the server would have already responded `202`.
