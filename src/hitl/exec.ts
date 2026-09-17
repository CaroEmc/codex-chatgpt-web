import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { ApprovalGateway } from "./approval";
import { EXEC_REJECTED_TEXT, formatCwdOutsideWorkspace, formatExecResult } from "./protocol";

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
 * of incremental re-bumps on every larger real occurrence.
 *
 * Both earlier open questions were confirmed by a real occurrence and are now handled in
 * spawnAndCapture: the old `spawn(..., { timeout })` SIGTERM reached only the shell and left a
 * delegated `codex exec` running as an orphan (the whole process tree is now killed), and `rg PATTERN`
 * with no path blocked on the never-closed stdin pipe for the full timeout (stdin is now closed).
 * Still open: this one constant governs both a one-liner and a multi-minute delegated review; a
 * per-request timeout field on EXEC_REQUEST would let ordinary commands fail faster. */
export const HITL_EXEC_TIMEOUT_MS = 600_000;

/** `workspaceCwd` is provider-level config (see `hitlWorkspaceCwd`), not resolved per-request:
 * the Responses API request this daemon receives from Codex carries no workspace/cwd field, so
 * there is nothing per-request to resolve against. */
function resolveWorkspaceCwd(request: RawExecRequest, workspaceCwd: string): string | undefined {
  const resolved = resolve(workspaceCwd, request.cwd ?? ".");
  const boundary = resolved === workspaceCwd || resolved.startsWith(`${workspaceCwd}${sep}`) || resolved.startsWith(`${workspaceCwd}/`);
  return boundary ? resolved : undefined;
}

/** EXEC_RESULT text is pasted into ChatGPT's rich-text composer, which rewrites some characters
 * (CR, tabs, exotic spaces) while keeping the length; the prompt-integrity check then fails the
 * whole turn. Normalize those to plain equivalents first -- the model only needs readable output. */
export function composerSafeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\t/g, "    ")
    .replace(/[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

/** `shell: true` puts a shell between us and the real command, so killing only `child` leaves the
 * command (and anything it spawned, e.g. a delegated `codex exec`) running as an orphan. */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

function spawnAndCapture(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolvePromise => {
    // stdin is closed: a command that falls back to reading stdin (e.g. `rg PATTERN` with no path)
    // must see EOF immediately instead of hanging until the timeout.
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    const append = (chunk: Buffer) => {
      if (capturedBytes >= OUTPUT_CAP_BYTES) return;
      chunks.push(chunk);
      capturedBytes += chunk.length;
    };
    // Decode once, so a multi-byte character (e.g. a CJK file name) split across two chunks is not
    // mangled; see composerSafeOutput for why the text is normalized afterwards.
    const captured = () => composerSafeOutput(Buffer.concat(chunks).toString("utf8"));
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", error => {
      clearTimeout(timer);
      resolvePromise({ exitCode: 1, output: `${captured()}\n${error.message}`.trim() });
    });
    child.on("close", code => {
      clearTimeout(timer);
      const truncated = captured().slice(0, OUTPUT_CAP_BYTES);
      const note = timedOut ? `${truncated}\n[truncated: command timed out after ${timeoutMs}ms]` : truncated;
      resolvePromise({ exitCode: timedOut ? 124 : (code ?? 1), output: note });
    });
  });
}

/** Always resolves — never throws — with the exact text to feed back to the model. */
export async function runApprovedCommand(
  gateway: ApprovalGateway,
  request: RawExecRequest,
  workspaceCwd: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const resolvedCwd = resolveWorkspaceCwd(request, workspaceCwd);
  if (!resolvedCwd) {
    console.warn(
      `[hitl] blocked EXEC_REQUEST without prompting: cwd "${request.cwd}" is outside workspace "${workspaceCwd}" (command: ${request.command})`,
    );
    return formatCwdOutsideWorkspace(request.cwd ?? ".", workspaceCwd);
  }

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

  const { exitCode, output } = await spawnAndCapture(decision.command, resolvedCwd, options.timeoutMs ?? HITL_EXEC_TIMEOUT_MS);
  return formatExecResult(exitCode, output);
}
