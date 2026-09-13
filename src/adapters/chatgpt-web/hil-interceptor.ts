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
  return (event: TEvent) => {
    if (event.type !== "text_delta" || typeof event.text !== "string") {
      // Non-text event: flush buffered and pass through
      if (buffered) {
        realEmit({ type: "text_delta", text: buffered } as TEvent);
        buffered = "";
      }
      realEmit(event);
      return;
    }

    const candidate = buffered + event.text;

    // Check if we have a complete, well-formed protocol block
    if (parseExecRequest(candidate)) {
      // Drop it entirely
      buffered = "";
      return;
    }

    // Check if we're in the middle of building a protocol block (has opening tag)
    if (candidate.includes("[EXEC_REQUEST")) {
      // Buffer to wait for closing tag
      buffered = candidate;
      return;
    }

    // Fast path: no brackets and no buffered content
    if (!buffered && !candidate.includes("[")) {
      realEmit(event);
      return;
    }

    // If buffered text is a strict prefix of "[EXEC_REQUEST", keep building
    if (buffered && "[EXEC_REQUEST".startsWith(buffered)) {
      buffered = candidate;
      return;
    }

    // At this point, candidate doesn't contain [EXEC_REQUEST and either:
    // - buffered is non-empty and not a prefix of "[EXEC_REQUEST", or
    // - buffered is empty but candidate contains "["
    // In both cases, we need to emit the buffered content (if any) without duplication

    // Flush any buffered content first (it's not part of a protocol block)
    if (buffered) {
      realEmit({ type: "text_delta", text: buffered } as TEvent);
    }

    // Now check if the new event text alone is a potential prefix of "[EXEC_REQUEST"
    if ("[EXEC_REQUEST".startsWith(event.text)) {
      // Could be starting a protocol block, buffer it
      buffered = event.text;
    } else {
      // Not a prefix, emit the new event directly
      buffered = "";
      realEmit(event);
    }
  };
}
