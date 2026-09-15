import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../../hitl/approval";
import { notifyLauncherHitlCancelled, requestLauncherHitlDecision } from "../../launcher-browser-host";

export interface HitlDesktopApprovalDeps {
  requestLauncherHitlDecision: typeof requestLauncherHitlDecision;
  notifyLauncherHitlCancelled: typeof notifyLauncherHitlCancelled;
}

const defaultDeps: HitlDesktopApprovalDeps = { requestLauncherHitlDecision, notifyLauncherHitlCancelled };

/** Wraps an `ApprovalGateway` so a HITL approval prompt can be answered either from the wrapped
 * gateway (the daemon's own terminal) or from a popup window the launcher opens -- whichever the
 * operator answers first wins. The loser is actively cancelled: the terminal's own abort signal
 * closes its readline prompt, and a best-effort cancel call closes a still-open popup. */
export function withDesktopApproval(
  gateway: ApprovalGateway,
  descriptorPath: string,
  deps: HitlDesktopApprovalDeps = defaultDeps,
): ApprovalGateway {
  return {
    async request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
      const race = new AbortController();
      const onOuterAbort = () => race.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      const traceId = proposal.traceId ?? "untraced";
      try {
        return await Promise.race([
          gateway.request(proposal, race.signal),
          deps.requestLauncherHitlDecision(
            descriptorPath,
            { traceId, command: proposal.command, cwd: proposal.cwd, reason: proposal.reason },
            race.signal,
          ),
        ]);
      } finally {
        race.abort();
        signal?.removeEventListener("abort", onOuterAbort);
        void deps.notifyLauncherHitlCancelled(descriptorPath, traceId);
      }
    },
  };
}
