import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../../hitl/approval";
import { notifyLauncherHitlApprovalPending } from "../../launcher-browser-host";

/** Wraps an `ApprovalGateway` so opening a HITL approval prompt also fires a best-effort desktop
 * notification through the launcher's Electron process. The wrapped gateway's terminal prompt
 * remains the source of truth: the notification is fired without being awaited, so a slow or
 * unreachable launcher can never delay or block the prompt it is nudging the operator toward. */
export function withDesktopNotify(gateway: ApprovalGateway, descriptorPath: string): ApprovalGateway {
  return {
    request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
      void notifyLauncherHitlApprovalPending(descriptorPath);
      return gateway.request(proposal, signal);
    },
  };
}
