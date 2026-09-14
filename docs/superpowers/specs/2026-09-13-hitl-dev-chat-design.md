# Design: Human-in-the-Loop Local Exec for DEV Chat

## 1. Context & Objective

`docs/hitl_prd.md` proposes a Streaming Interceptor Hook: a text-based
`[EXEC_REQUEST]`/`[EXEC_RESULT]` protocol that lets a ChatGPT Web session request local
command execution, gated by an interactive terminal approval step, without standing up
the existing `full`-mode OpenAI Tunnel / MCP connector.

This spec scopes a first implementation of that protocol inside the repository's `dev
chat` CLI (`src/dev-chat/`), which already drives a real ChatGPT browser turn through the
production adapter (`browser-worker.ts` / `turn-execution.ts`) without touching the real
Codex-facing Responses daemon. Production `browser-only` daemon integration — wiring the
same protocol into the real Electron-driven daemon that Codex talks to — is an explicit
follow-on once this proves out, and is out of scope here.

This is an add-on inside `browser-only`-style sessions specifically: `full` mode already
has real structured tool calls via the MCP connector and is untouched by this feature.

## 2. Why `dev chat` is the right first target

`DevChatDriver.send()` (`src/dev-chat/driver.ts`) runs a real ChatGPT browser turn via
`responseRequest`/the production `chatgpt-web` adapter, inside a bounded round-loop (cap
64 rounds) that reuses the same `turnId`/thread identity across rounds — this is exactly
the mechanism needed to auto-inject an `[EXEC_RESULT]` message and continue the same
logical turn. Because `send()` calls `responseRequest` non-streaming and receives one
complete envelope per round, no SSE sliding-buffer state machine (PRD §3.2) is required
for this scope: detection runs against each round's already-complete output text.

## 3. Activation

- New per-dev-chat flag `hitlEnabled: boolean`, set via a new CLI flag `dev chat NAME
  --hitl` (`src/dev-chat/cli.ts`), persisted in `DevChatState` (`src/dev-chat/session.ts`)
  the same way `model` is.
- HITL is only usable in browser-only DEV sessions (`config.mode !== "full"`). Requesting
  `--hitl` while `mode === "full"` fails explicitly with a clear error — full mode already
  has real tools and must not also parse prose as commands.
- When active, `requestBody()` (`src/dev-chat/driver.ts`) selects a new instructions
  constant `DEV_CHAT_HITL_INSTRUCTIONS` (parallel to `DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS`)
  containing the PRD §3.1 protocol block, telling the model to emit `[EXEC_REQUEST]` and
  halt rather than fabricate output.

## 4. Protocol module

New `src/dev-chat/hitl-protocol.ts`:

- `parseExecRequest(text: string): { command: string; cwd?: string; reason?: string } |
  undefined` — matches the PRD's `[EXEC_REQUEST] ... [/EXEC_REQUEST]` block with the given
  regex. Returns `undefined` on no match or a malformed/incomplete block (missing
  `command`), which is treated as an ordinary final answer — this is the fallback the PRD
  describes for buffering, simplified because there is no partial-stream state here.
- `formatExecResult(exitCode: number, output: string): string` — builds the `[EXEC_RESULT]`
  block (PRD §3.4).
- A literal `EXEC_REJECTED_TEXT = "User rejected execution."` constant, fed back verbatim
  per PRD §3.3 when the user rejects.

## 5. Detection point in the round loop

In `DevChatDriver.send()`, the existing branch:

```ts
if (calls.length === 0) {
  if (envelope.end_turn !== true) throw new Error(...);
  finalText = outputText(output);
  ... return ...
}
```

gains a HITL check ahead of the return: when `state.hitlEnabled` and `calls.length === 0`,
run `parseExecRequest(outputText(output))`. If it matches, do **not** return — proceed to
approval/execution (§6/§7) and push the result as the next round's input, then `continue`
the same `for` loop using the existing `turnId`. If it doesn't match, existing behavior
(return final text) is unchanged. The existing 64-round cap becomes the safety bound for
EXEC rounds too — no new counter is introduced.

## 6. Approval gateway

New `src/dev-chat/hitl-approval.ts`:

```ts
interface ExecProposal { command: string; cwd: string; reason?: string }
type ApprovalDecision =
  | { action: "run"; command: string }
  | { action: "reject" };

interface ApprovalGateway {
  request(proposal: ExecProposal): Promise<ApprovalDecision>;
}
```

- `TtyApprovalGateway` is the only implementation built now. It renders the PRD §3.3 box
  via `stdout` and reads a single line via the same `node:readline/promises` pattern
  already used for interactive dev-chat input (`src/dev-chat/cli.ts`).
  - `y` / Enter → `{ action: "run", command: proposal.command }`
  - `c` → prompts for a replacement command line (empty input keeps the original), then
    `{ action: "run", command: <edited> }`
  - `n` / Esc / Ctrl-C / Ctrl-D → `{ action: "reject" }`
- If `!stdin.isTTY`, `TtyApprovalGateway.request` resolves `{ action: "reject" }`
  immediately without prompting — this is the fail-closed behavior PRD §Phase 3 asks for,
  and it is what naturally happens for one-shot non-interactive invocations
  (`dev chat NAME "message"` with no attached terminal).
- The interface is intentionally the only coupling point for a later launcher-UI
  implementation; no launcher UI work is included in this spec.

## 7. Execution

- `child_process.spawn(command, { cwd, shell: true, timeout: 60_000 })` (Node's built-in
  `timeout` option is sufficient for the PRD's 60s guard; no custom timer).
- `cwd` resolution: if the request omits `cwd`, use the dev-chat's own `cwd`
  (`DevChatDriver.cwd`). If a `cwd` is given, resolve it against the dev-chat's `cwd` and
  reject the request *before it reaches approval* (feeding back a clear rejection message,
  not a thrown error that aborts the chat) if the resolved path is not inside the
  dev-chat's workspace root — the PRD's "defaults to the active workspace directory"
  constraint (§5) becomes a hard boundary rather than only a default.
- Combined stdout+stderr captured and truncated to the first 10KB (matching PRD §3.4);
  exit code captured; a timeout is reported as a synthetic non-zero exit with a truncation
  note rather than left hanging.
- Result is formatted with `formatExecResult` and appended to `workingInput` as a plain
  `input_text` user message (the same item shape `currentTurnItems` already builds for the
  initial prompt) carrying the current round's `turnId` metadata, so it becomes the next
  message in the same Temporary Chat/thread.

## 8. CLI/UX

- `dev-chat/cli.ts`: add the `--hitl` flag to `dev chat`, help text update, and reject its
  use with `--model` implying `mode === "full"` (i.e. `chatgpt-web/zero-risk` and any
  route resolved under `mode: "full"`).
- `EventRenderer` gains rendering for exec proposals/approvals/results, distinct from the
  existing `tool_call`/`tool_result` rendering (those remain for `full`-mode simulated
  tools and are unaffected).

## 9. Testing

- Unit tests for `parseExecRequest`/`formatExecResult` (well-formed, malformed, absent,
  multiple blocks — only the first is honored, per streaming-buffer intent).
- Unit tests for the approval gateway's `y`/`c`/`n`/no-TTY paths using an injected
  readline/stdin fake, matching existing dev-chat test patterns.
- A `DevChatDriver.send()` test exercising the full loop: EXEC_REQUEST → approval → exec →
  EXEC_RESULT round-trip → final answer, using the same test doubles the existing
  dev-chat tests already use for `responseRequest`.

## 10. Non-goals

- No changes to the production browser-only daemon, `browser-worker.ts` turn submission,
  or the SSE-facing Responses route Codex actually talks to.
- No Electron/launcher UI approval surface (interface left ready for one).
- No change to `full` mode, the MCP connector, or the OpenAI Tunnel.
- No sliding-buffer SSE state machine (not applicable to `dev chat`'s non-streaming round
  loop).
