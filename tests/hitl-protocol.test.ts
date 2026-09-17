import { expect, test } from "bun:test";
import {
  DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS,
  HITL_BATCH_EXAMPLE,
  HITL_EXEC_DEFAULT_TIMEOUT_SECONDS,
  HITL_EXEC_MAX_TIMEOUT_SECONDS,
  HITL_SHELL_NOTE,
  EXEC_REJECTED_TEXT,
  formatExecResult,
  parseExecRequest,
} from "../src/hitl/protocol";
import { HITL_EXEC_TIMEOUT_MS } from "../src/hitl/exec";

test("parses a well-formed EXEC_REQUEST block", () => {
  const text = [
    "Let me check the repo.",
    "[EXEC_REQUEST]",
    "command: git status -s",
    "cwd: /workspace/project",
    "reason: Check repository status",
    "[/EXEC_REQUEST]",
  ].join("\n");
  expect(parseExecRequest(text)).toEqual({
    command: "git status -s",
    cwd: "/workspace/project",
    reason: "Check repository status",
  });
});

test("parses a request with only the required command field", () => {
  const text = "[EXEC_REQUEST]\ncommand: ls\n[/EXEC_REQUEST]";
  expect(parseExecRequest(text)).toEqual({ command: "ls", cwd: undefined, reason: undefined });
});

test("returns undefined for plain text with no request block", () => {
  expect(parseExecRequest("Here is my answer, no command needed.")).toBeUndefined();
});

test("returns undefined for a malformed block missing the command field", () => {
  const text = "[EXEC_REQUEST]\nreason: no command given\n[/EXEC_REQUEST]";
  expect(parseExecRequest(text)).toBeUndefined();
});

test("returns undefined for an unclosed block", () => {
  const text = "[EXEC_REQUEST]\ncommand: ls\n";
  expect(parseExecRequest(text)).toBeUndefined();
});

test("only the first block is honored when multiple appear", () => {
  const text = [
    "[EXEC_REQUEST]",
    "command: first",
    "[/EXEC_REQUEST]",
    "[EXEC_REQUEST]",
    "command: second",
    "[/EXEC_REQUEST]",
  ].join("\n");
  expect(parseExecRequest(text)).toEqual({ command: "first", cwd: undefined, reason: undefined });
});

test("formats an EXEC_RESULT block", () => {
  expect(formatExecResult(0, "M src/index.ts\n?? src/interceptor.ts")).toBe(
    "[EXEC_RESULT]\nexit_code: 0\noutput:\nM src/index.ts\n?? src/interceptor.ts\n[/EXEC_RESULT]",
  );
});

test("the rejection text is the exact literal the model should see", () => {
  expect(EXEC_REJECTED_TEXT).toBe("User rejected execution.");
});

test("HITL protocol instructions teach subagent delegation via codex exec, since no MCP subagent tool is available in this transport", () => {
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("codex exec");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("no MCP subagent tool is available");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("command: codex exec");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("no memory of this conversation");
  // Never invite --dangerously-bypass-approvals-and-sandbox for a delegated sub-task.
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("Never add --dangerously-bypass-approvals-and-sandbox");
});

test("delegation guidance warns about the single-line command field and the shell-quoting risk of a free-text prompt", () => {
  // The command field is one raw line (FIELD_LINE matches ^command:\\s*(.*)$); a prompt with an
  // embedded newline is silently truncated by parseExecRequest, and one with an embedded backtick
  // or $(...) is shell-interpolated at spawn time if double-quoted. The instructions must steer the
  // model away from both failure modes instead of silently producing broken or unsafe commands.
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("one line");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("single quotes");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("double quotes");
});

test("delegation guidance warns about the exec timeout and output cap so sub-tasks are scoped to survive both", () => {
  // Anchored to the real constant, not a hardcoded number, so the instructions can't silently
  // drift out of sync with the actual timeout the next time it changes.
  expect(HITL_EXEC_TIMEOUT_MS % 1000).toBe(0);
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain(`${HITL_EXEC_TIMEOUT_MS / 1000}-second`);
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("10KB");
});

test("the rejection text is the exact literal the model should see", () => {
  expect(EXEC_REJECTED_TEXT).toBe("User rejected execution.");
});

test("every literal EXEC_REQUEST marker in the instructions is part of a real matched block, never bare in explanatory prose", () => {
  // createHitlEmitFilter buffers all subsequent streamed text once it sees a bare "[EXEC_REQUEST"
  // substring, releasing it only once a complete block parses or the substring stops matching --
  // so teaching the model to write that bracketed token in ordinary prose (not as an actual
  // protocol block) risks withholding the rest of a real answer from the user.
  const openCount = DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS.split("[EXEC_REQUEST]").length - 1;
  const closeCount = DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS.split("[/EXEC_REQUEST]").length - 1;
  expect(openCount).toBe(closeCount);
});

test("a delegation command line shaped exactly like the instructed example round-trips through parseExecRequest", () => {
  const text = [
    "[EXEC_REQUEST]",
    "command: codex exec -C /repo -s read-only --skip-git-repo-check -o /tmp/subagent-report.txt 'Review the diff in scripts/foo.py and report Critical/Important/Minor issues.'",
    "reason: Delegate an independent review since no MCP subagent tool is available",
    "[/EXEC_REQUEST]",
  ].join("\n");
  const parsed = parseExecRequest(text);
  expect(parsed?.command).toBe(
    "codex exec -C /repo -s read-only --skip-git-repo-check -o /tmp/subagent-report.txt 'Review the diff in scripts/foo.py and report Critical/Important/Minor issues.'",
  );
});

test("documents the existing single-line limit: a command value with an embedded newline is silently truncated to its first line", () => {
  // parseExecRequest only recognizes command/cwd/reason lines and drops every other line via
  // `continue` -- so a multi-line prompt embedded in `command:` is not an error, just silent data
  // loss. This is why the delegation instructions insist on a single-line, single-quoted prompt
  // rather than relying on the parser to support more than that.
  const text = [
    "[EXEC_REQUEST]",
    "command: codex exec -C /repo 'first line of the prompt",
    "second line is silently dropped, not part of command'",
    "[/EXEC_REQUEST]",
  ].join("\n");
  expect(parseExecRequest(text)?.command).toBe("codex exec -C /repo 'first line of the prompt");
});

test("HITL instructions ask the model to batch read-only queries using the real shell's separator", () => {
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("batch read-only inspection");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain(HITL_SHELL_NOTE);
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain(HITL_BATCH_EXAMPLE);
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("explicit paths");
  if (process.platform === "win32") {
    expect(HITL_SHELL_NOTE).toContain("cmd.exe");
    expect(HITL_BATCH_EXAMPLE).toContain(" & ");
    expect(HITL_BATCH_EXAMPLE).not.toContain(";");
  } else {
    expect(HITL_BATCH_EXAMPLE).toContain("; ");
  }
});

test("the batching example is itself a valid single-line command field", () => {
  const parsed = parseExecRequest(`[EXEC_REQUEST]\n${HITL_BATCH_EXAMPLE}\ncwd: .\n[/EXEC_REQUEST]`);
  expect(parsed?.command).toBe(HITL_BATCH_EXAMPLE.slice("command: ".length));
});

test("the timeout field is parsed in seconds, clamped to the maximum, and ignored when invalid", () => {
  const block = (timeout: string) => `[EXEC_REQUEST]\ncommand: npm test\ntimeout: ${timeout}\n[/EXEC_REQUEST]`;
  expect(parseExecRequest(block("300"))?.timeoutSeconds).toBe(300);
  expect(parseExecRequest(block("45s"))?.timeoutSeconds).toBe(45);
  expect(parseExecRequest(block("120 seconds"))?.timeoutSeconds).toBe(120);
  expect(parseExecRequest(block("99999"))?.timeoutSeconds).toBe(HITL_EXEC_MAX_TIMEOUT_SECONDS);
  expect(parseExecRequest(block("0"))?.timeoutSeconds).toBeUndefined();
  expect(parseExecRequest(block("soon"))?.timeoutSeconds).toBeUndefined();
  expect(parseExecRequest("[EXEC_REQUEST]\ncommand: ls\n[/EXEC_REQUEST]")).toEqual({
    command: "ls",
    cwd: undefined,
    reason: undefined,
  });
});

test("HITL instructions teach the timeout field and keep commands inside the workspace", () => {
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("timeout: <optional seconds");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain(`stopped after ${HITL_EXEC_DEFAULT_TIMEOUT_SECONDS} seconds`);
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain("never scan outside the workspace");
  expect(DEV_CHAT_HITL_PROTOCOL_INSTRUCTIONS).toContain(`set timeout: ${HITL_EXEC_MAX_TIMEOUT_SECONDS}`);
});
