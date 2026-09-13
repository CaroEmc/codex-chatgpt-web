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
  // Buffer the actual candidate `text_delta` events (not just their concatenated text) so a
  // flush can replay them verbatim -- including `phase` and any other fields the caller attached
  // -- instead of synthesizing a bare `{ type: "text_delta", text }` that silently drops them.
  // Dropping `phase` matters beyond cosmetics: bridge.ts closes/reopens transcript output items
  // on a phase change, so a flushed-but-rephrased event fragments the transcript.
  let bufferedEvents: TEvent[] = [];
  let buffered = "";

  const flushBuffered = (): void => {
    for (const bufferedEvent of bufferedEvents) realEmit(bufferedEvent);
    bufferedEvents = [];
    buffered = "";
  };

  return (event: TEvent) => {
    if (event.type !== "text_delta" || typeof event.text !== "string") {
      // Non-text event: flush buffered and pass through
      flushBuffered();
      realEmit(event);
      return;
    }

    const candidate = buffered + event.text;

    // Check if we have a complete, well-formed protocol block
    if (parseExecRequest(candidate)) {
      // Drop it entirely
      bufferedEvents = [];
      buffered = "";
      return;
    }

    // Check if we're in the middle of building a protocol block (has opening tag)
    if (candidate.includes("[EXEC_REQUEST")) {
      // Buffer to wait for closing tag
      bufferedEvents.push(event);
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
      bufferedEvents.push(event);
      buffered = candidate;
      return;
    }

    // At this point, candidate doesn't contain [EXEC_REQUEST and either:
    // - buffered is non-empty and not a prefix of "[EXEC_REQUEST", or
    // - buffered is empty but candidate contains "["
    // In both cases, we need to emit the buffered content (if any) without duplication

    // Flush any buffered content first (it's not part of a protocol block); replaying the
    // original buffered events preserves each one's own `phase`/other fields verbatim.
    flushBuffered();

    // Now check if the new event text alone is a potential prefix of "[EXEC_REQUEST"
    if ("[EXEC_REQUEST".startsWith(event.text)) {
      // Could be starting a protocol block, buffer it
      bufferedEvents = [event];
      buffered = event.text;
    } else {
      // Not a prefix, emit the new event directly
      realEmit(event);
    }
  };
}
