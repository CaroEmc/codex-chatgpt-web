import { expect, test } from "bun:test";
import { createHilExecGate, createHilEmitFilter } from "../src/adapters/chatgpt-web/hil-interceptor";
import type { ApprovalGateway, ApprovalDecision } from "../src/hil/approval";

function fakeGateway(decision: ApprovalDecision): ApprovalGateway {
  return { request: async () => decision };
}

test("createHilExecGate finalizes when there is no EXEC_REQUEST block", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    workspaceCwd: "/workspace",
  });
  expect(await gate.check("Just a normal final answer.")).toEqual({ action: "finalize" });
});

test("createHilExecGate resumes with the formatted EXEC_RESULT after an approved run", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "run", command: "echo hi" }),
    workspaceCwd: "/workspace",
    runCommand: async (_gateway, request, workspaceCwd) => {
      expect(request.command).toBe("echo hi");
      expect(workspaceCwd).toBe("/workspace");
      return "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]";
    },
  });
  const text = "[EXEC_REQUEST]\ncommand: echo hi\n[/EXEC_REQUEST]";
  expect(await gate.check(text)).toEqual({
    action: "resume",
    followUpText: "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]",
  });
});

test("createHilExecGate resumes with the rejection text when the gateway rejects", async () => {
  const gate = createHilExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    workspaceCwd: "/workspace",
  });
  const text = "[EXEC_REQUEST]\ncommand: rm -rf /\n[/EXEC_REQUEST]";
  expect(await gate.check(text)).toEqual({
    action: "resume",
    followUpText: "User rejected execution.",
  });
});

test("createHilEmitFilter passes ordinary text straight through", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "hello " });
  filtered({ type: "text_delta", text: "world" });
  expect(seen).toEqual([
    { type: "text_delta", text: "hello " },
    { type: "text_delta", text: "world" },
  ]);
});

test("createHilEmitFilter withholds a completed EXEC_REQUEST block entirely", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[EXEC_REQUEST]\n" });
  filtered({ type: "text_delta", text: "command: ls\n[/EXEC_REQUEST]" });
  filtered({ type: "done" });
  expect(seen).toEqual([{ type: "done" }]);
});

test("createHilEmitFilter flushes verbatim when a [-prefixed delta turns out not to match", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[not a protocol block]" });
  expect(seen).toEqual([{ type: "text_delta", text: "[not a protocol block]" }]);
});

test("createHilEmitFilter handles bracketed text split across calls without duplication", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "see [" });
  filtered({ type: "text_delta", text: "1] for details" });
  // Reconstruct emitted text
  const reconstructed = seen.map(e => e.text || "").join("");
  expect(reconstructed).toBe("see [1] for details");
  expect(seen).toEqual([
    { type: "text_delta", text: "see [" },
    { type: "text_delta", text: "1] for details" },
  ]);
});

test("createHilEmitFilter handles EXEC_REQUEST split mid-token across calls", () => {
  const seen: unknown[] = [];
  const filtered = createHilEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[EXEC_REQ" });
  filtered({ type: "text_delta", text: "UEST]\ncommand: ls\n[/EXEC_REQUEST]" });
  filtered({ type: "done" });
  // Should only see the done event, protocol block is withheld
  expect(seen).toEqual([{ type: "done" }]);
});
