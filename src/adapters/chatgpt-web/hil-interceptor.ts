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
    // Check if buffered starts with [ but can't possibly be EXEC_REQUEST
    if (buffered.startsWith("[")) {
      // It's a potential prefix if [EXEC_REQUEST starts with it, or it starts with [EXEC_REQUEST
      if (!"[EXEC_REQUEST".startsWith(buffered) && !buffered.startsWith("[EXEC_REQUEST")) {
        flush();
        return;
      }
    }
    if (buffered.includes("[/EXEC_REQUEST]") && !parseExecRequest(buffered)) {
      flush();
    }
  };
}
