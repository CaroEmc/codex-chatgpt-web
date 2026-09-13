import { expect, test } from "bun:test";
import { EXEC_REJECTED_TEXT, formatExecResult, parseExecRequest } from "../src/hil/protocol";

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
