export interface ParsedExecRequest {
  command: string;
  cwd?: string;
  reason?: string;
}

const EXEC_REQUEST_BLOCK = /\[EXEC_REQUEST\]\s*([\s\S]*?)\s*\[\/EXEC_REQUEST\]/;
const FIELD_LINE = /^\s*(command|cwd|reason)\s*:\s*(.*)$/i;

/** Only the first well-formed block is honored; a missing/incomplete block returns undefined
 * so the caller falls back to treating the text as an ordinary final answer. */
export function parseExecRequest(text: string): ParsedExecRequest | undefined {
  const match = EXEC_REQUEST_BLOCK.exec(text);
  if (!match) return undefined;
  const fields: Partial<Record<"command" | "cwd" | "reason", string>> = {};
  for (const line of match[1]!.split("\n")) {
    const fieldMatch = FIELD_LINE.exec(line);
    if (!fieldMatch) continue;
    const key = fieldMatch[1]!.toLowerCase() as "command" | "cwd" | "reason";
    if (fields[key] === undefined) fields[key] = fieldMatch[2]!.trim();
  }
  if (!fields.command) return undefined;
  return { command: fields.command, cwd: fields.cwd, reason: fields.reason };
}

export function formatExecResult(exitCode: number, output: string): string {
  return `[EXEC_RESULT]\nexit_code: ${exitCode}\noutput:\n${output}\n[/EXEC_RESULT]`;
}

export const EXEC_REJECTED_TEXT = "User rejected execution.";

/** Returned instead of EXEC_REJECTED_TEXT when the requested cwd escapes the workspace, so the
 * model can retry with a valid path rather than concluding the operator declined. */
export function formatCwdOutsideWorkspace(requestedCwd: string, workspaceCwd: string): string {
  return [
    `Execution blocked before approval: cwd "${requestedCwd}" resolves outside the workspace root "${workspaceCwd}".`,
    "The operator did not reject this request. Retry with a cwd relative to the workspace root (for example `.` or `doc`), not an absolute path.",
  ].join("\n");
}

export function hitlWorkspaceInstructions(workspaceCwd: string): string {
  return [
    `The workspace root for EXEC_REQUEST is: ${workspaceCwd}`,
    "The cwd field must be a path relative to that root (use . for the root itself); a cwd resolving outside it is blocked.",
  ].join("\n");
}

const WINDOWS_SHELL = process.platform === "win32";

/** exec.ts runs commands through `spawn(..., { shell: true })`: cmd.exe on Windows, /bin/sh elsewhere.
 * cmd.exe does not treat `;` as a separator, so the batching example must match the real shell. */
export const HITL_SHELL_NOTE = WINDOWS_SHELL
  ? "Commands run in Windows cmd.exe: separate commands with & (not ;), use && only when a later part must depend on an earlier one, and use dir /b, type, and rg rather than ls, cat, and head."
  : "Commands run in /bin/sh: separate commands with ; and use && only when a later part must depend on an earlier one.";

export const HITL_BATCH_EXAMPLE = WINDOWS_SHELL
  ? "command: echo === files === & dir /b doc & echo === matches === & rg -n -i libfoo doc src"
  : "command: echo '=== files ==='; ls doc; echo '=== matches ==='; rg -n -i libfoo doc src";

export const DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS = [
  "When you need to execute shell commands, read files, or inspect project state,",
  "strictly output the following format and halt generation immediately:",
  "[EXEC_REQUEST]",
  "command: <command to execute>",
  "cwd: <target working directory, defaults to .>",
  "reason: <rationale for executing this command>",
  "[/EXEC_REQUEST]",
  "Do not fabricate outputs. Do not produce subsequent summaries until you receive [EXEC_RESULT].",
  "",
  "Every request costs a full round trip, so batch read-only inspection: gather everything the next step needs",
  "in ONE command instead of issuing one command per question. Chain independent read-only queries",
  "(listing a directory, searching it, printing the head of a file) with the shell's command separator,",
  "and print a short label before each part so the outputs can be told apart, e.g.:",
  HITL_BATCH_EXAMPLE,
  "Keep the combined output well under the 10KB cap. Always pass explicit paths to search tools such as",
  "rg or grep; without a path they wait for stdin instead of searching. Do not batch commands that modify",
  "files, or a command whose result decides what to run next.",
  HITL_SHELL_NOTE,
  "",
  "To delegate an independent sub-task, no MCP subagent tool is available in this transport.",
  "Issue an EXEC_REQUEST block whose command runs `codex exec` non-interactively instead, e.g.:",
  "command: codex exec -C <repo-dir> -s read-only --skip-git-repo-check -o /tmp/subagent-report.txt 'Review scripts/foo.py:10-40 for correctness bugs; report a short verdict.'",
  "The command field is exactly one line, so the task prompt must also fit on that one line:",
  "wrap it in single quotes (never double quotes -- those let the shell expand backticks and",
  "$(...) inside your own prompt text), keep it free of embedded single quotes, and keep it short:",
  "the command has a 600-second timeout and its output is capped at 10KB, so scope the sub-task",
  "narrowly (e.g. one file or one question, not a full audit) and tell it to report only a brief",
  "verdict. Give it a fully self-contained prompt -- it starts with no memory of this conversation.",
  "Never add --dangerously-bypass-approvals-and-sandbox to this command.",
  "Then read the result with a second EXEC_REQUEST block running: cat /tmp/subagent-report.txt",
  "Use -s workspace-write only if the sub-task must edit files itself.",
].join("\n");
