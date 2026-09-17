import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import type { ApprovalGateway } from "./approval";
import {
  EXEC_REJECTED_TEXT,
  formatCwdOutsideWorkspace,
  formatExecResult,
  HITL_EXEC_DEFAULT_TIMEOUT_SECONDS,
  HITL_EXEC_MAX_TIMEOUT_SECONDS,
} from "./protocol";

export interface RawExecRequest {
  command: string;
  cwd?: string;
  reason?: string;
  /** From the EXEC_REQUEST `timeout:` field; defaults to HITL_EXEC_DEFAULT_TIMEOUT_MS. */
  timeoutSeconds?: number;
}

const OUTPUT_CAP_BYTES = 10 * 1024;
/** Longest run a request may ask for. A delegated `codex exec` sub-task (see
 * DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS) has been observed at 60,886ms and 290,779ms, so the ceiling
 * leaves real headroom. Ordinary commands use the much shorter HITL_EXEC_DEFAULT_TIMEOUT_MS: a
 * whole-profile `dir /s` once stalled a turn for minutes under a single shared 10-minute limit.
 * spawnAndCapture kills the whole process tree on timeout and closes stdin, so neither an orphaned
 * `codex exec` nor a stdin-waiting `rg PATTERN` outlives the limit. */
export const HITL_EXEC_TIMEOUT_MS = HITL_EXEC_MAX_TIMEOUT_SECONDS * 1000;
export const HITL_EXEC_DEFAULT_TIMEOUT_MS = HITL_EXEC_DEFAULT_TIMEOUT_SECONDS * 1000;
/** How often a still-running command is reported on the daemon's terminal. */
export const HITL_EXEC_PROGRESS_INTERVAL_MS = 30_000;

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

interface SpawnOptions {
  timeoutMs: number;
  progressIntervalMs: number;
  report: (line: string) => void;
}

function spawnAndCapture(
  command: string,
  cwd: string,
  { timeoutMs, progressIntervalMs, report }: SpawnOptions,
): Promise<{ exitCode: number; output: string }> {
  return new Promise(resolvePromise => {
    const startedAt = Date.now();
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
      report(`[hitl] stopping after ${Math.round(timeoutMs / 1000)}s (timeout): ${command}`);
      killProcessTree(child.pid);
    }, timeoutMs);
    // A long command otherwise looks exactly like a hung turn from the operator's terminal.
    const progress = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      report(`[hitl] still running after ${elapsed}s (limit ${Math.round(timeoutMs / 1000)}s): ${command}`);
    }, progressIntervalMs);
    const stopTimers = () => {
      clearTimeout(timer);
      clearInterval(progress);
    };
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
      stopTimers();
      resolvePromise({ exitCode: 1, output: `${captured()}\n${error.message}`.trim() });
    });
    child.on("close", code => {
      stopTimers();
      const truncated = captured().slice(0, OUTPUT_CAP_BYTES);
      const note = timedOut
        ? `${truncated}\n[truncated: command timed out after ${timeoutMs}ms; narrow the command, or set a longer timeout: field if it genuinely needs more time]`
        : truncated;
      resolvePromise({ exitCode: timedOut ? 124 : (code ?? 1), output: note });
    });
  });
}

/** Always resolves — never throws — with the exact text to feed back to the model. */
export async function runApprovedCommand(
  gateway: ApprovalGateway,
  request: RawExecRequest,
  workspaceCwd: string,
  options: {
    /** Overrides the request's own timeout (tests). */
    timeoutMs?: number;
    progressIntervalMs?: number;
    report?: (line: string) => void;
  } = {},
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

  const requestedMs = request.timeoutSeconds === undefined
    ? HITL_EXEC_DEFAULT_TIMEOUT_MS
    : Math.min(request.timeoutSeconds * 1000, HITL_EXEC_TIMEOUT_MS);
  const { exitCode, output } = await spawnAndCapture(decision.command, resolvedCwd, {
    timeoutMs: options.timeoutMs ?? requestedMs,
    progressIntervalMs: options.progressIntervalMs ?? HITL_EXEC_PROGRESS_INTERVAL_MS,
    report: options.report ?? (line => console.log(line)),
  });
  return formatExecResult(exitCode, output);
}
