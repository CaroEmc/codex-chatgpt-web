import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { ApprovalGateway } from "./approval";
import { EXEC_REJECTED_TEXT, formatExecResult } from "./protocol";

export interface RawExecRequest {
  command: string;
  cwd?: string;
  reason?: string;
}

const OUTPUT_CAP_BYTES = 10 * 1024;
/** A delegated `codex exec` sub-task (see DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS) observed 60,886ms in
 * one real occurrence, then 290,779ms in another -- doubling the previous 60,000ms bound to
 * 120,000ms already proved insufficient once. Review duration varies a lot with scope rather than
 * clustering near one worst case, so this channel (already human-approval-gated -- nothing runs
 * unsupervised, and the human already watched the command start) gets a generous ceiling instead
 * of incremental re-bumps on every larger real occurrence. */
export const HITL_EXEC_TIMEOUT_MS = 600_000;

/** `workspaceCwd` is provider-level config (see `hitlWorkspaceCwd`), not resolved per-request:
 * the Responses API request this daemon receives from Codex carries no workspace/cwd field, so
 * there is nothing per-request to resolve against. */
function resolveWorkspaceCwd(request: RawExecRequest, workspaceCwd: string): string | undefined {
  const resolved = resolve(workspaceCwd, request.cwd ?? ".");
  const boundary = resolved === workspaceCwd || resolved.startsWith(`${workspaceCwd}/`);
  return boundary ? resolved : undefined;
}

function spawnAndCapture(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn(command, { cwd, shell: true, timeout: HITL_EXEC_TIMEOUT_MS });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      if (output.length >= OUTPUT_CAP_BYTES) return;
      output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", error => resolvePromise({ exitCode: 1, output: `${output}\n${error.message}`.trim() }));
    child.on("close", (code, signal) => {
      if (signal === "SIGTERM" && code === null) timedOut = true;
      const truncated = output.slice(0, OUTPUT_CAP_BYTES);
      const note = timedOut ? `${truncated}\n[truncated: command timed out after ${HITL_EXEC_TIMEOUT_MS}ms]` : truncated;
      resolvePromise({ exitCode: timedOut ? 124 : (code ?? 1), output: note });
    });
  });
}

/** Always resolves — never throws — with the exact text to feed back to the model. */
export async function runApprovedCommand(
  gateway: ApprovalGateway,
  request: RawExecRequest,
  workspaceCwd: string,
): Promise<string> {
  const resolvedCwd = resolveWorkspaceCwd(request, workspaceCwd);
  if (!resolvedCwd) return EXEC_REJECTED_TEXT;

  let decision;
  try {
    decision = await gateway.request({
      command: request.command,
      cwd: resolvedCwd,
      reason: request.reason,
    });
  } catch {
    return EXEC_REJECTED_TEXT;
  }
  if (decision.action === "reject") return EXEC_REJECTED_TEXT;

  const { exitCode, output } = await spawnAndCapture(decision.command, resolvedCwd);
  return formatExecResult(exitCode, output);
}
