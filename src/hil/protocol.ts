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

export const DEV_CHAT_HIL_PROTOCOL_INSTRUCTIONS = [
  "When you need to execute shell commands, read files, or inspect project state,",
  "strictly output the following format and halt generation immediately:",
  "[EXEC_REQUEST]",
  "command: <command to execute>",
  "cwd: <target working directory, defaults to .>",
  "reason: <rationale for executing this command>",
  "[/EXEC_REQUEST]",
  "Do not fabricate outputs. Do not produce subsequent summaries until you receive [EXEC_RESULT].",
].join("\n");
