import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHitlExecGate, createHitlEmitFilter, HitlApprovalQueue } from "../src/adapters/chatgpt-web/hitl-interceptor";
import type { ApprovalGateway, ApprovalDecision, ExecProposal } from "../src/hitl/approval";

function fakeGateway(decision: ApprovalDecision): ApprovalGateway {
  return { request: async () => decision };
}

test("createHitlExecGate finalizes when there is no EXEC_REQUEST block", async () => {
  const gate = createHitlExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    workspaceCwd: "/workspace",
  });
  expect(await gate.check("Just a normal final answer.")).toEqual({ action: "finalize" });
});

test("createHitlExecGate resumes with the formatted EXEC_RESULT after an approved run", async () => {
  const gate = createHitlExecGate({
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

test("createHitlExecGate resumes with the rejection text when the gateway rejects", async () => {
  const gate = createHitlExecGate({
    approvalGateway: fakeGateway({ action: "reject" }),
    // Platform-absolute, so the request reaches the gateway instead of the cwd boundary check.
    workspaceCwd: resolve("/workspace"),
  });
  const text = "[EXEC_REQUEST]\ncommand: rm -rf /\n[/EXEC_REQUEST]";
  expect(await gate.check(text)).toEqual({
    action: "resume",
    followUpText: "User rejected execution.",
  });
});

test("createHitlEmitFilter passes ordinary text straight through", () => {
  const seen: unknown[] = [];
  const filtered = createHitlEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "hello " });
  filtered({ type: "text_delta", text: "world" });
  expect(seen).toEqual([
    { type: "text_delta", text: "hello " },
    { type: "text_delta", text: "world" },
  ]);
});

test("createHitlEmitFilter withholds a completed EXEC_REQUEST block entirely", () => {
  const seen: unknown[] = [];
  const filtered = createHitlEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[EXEC_REQUEST]\n" });
  filtered({ type: "text_delta", text: "command: ls\n[/EXEC_REQUEST]" });
  filtered({ type: "done" });
  expect(seen).toEqual([{ type: "done" }]);
});

test("createHitlEmitFilter flushes verbatim when a [-prefixed delta turns out not to match", () => {
  const seen: unknown[] = [];
  const filtered = createHitlEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[not a protocol block]" });
  expect(seen).toEqual([{ type: "text_delta", text: "[not a protocol block]" }]);
});

test("createHitlEmitFilter handles bracketed text split across calls without duplication", () => {
  type TestEvent = { type: string; text?: string; phase?: string };
  const seen: TestEvent[] = [];
  const filtered = createHitlEmitFilter<TestEvent>(event => seen.push(event));
  filtered({ type: "text_delta", text: "see [" });
  filtered({ type: "text_delta", text: "1] for details" });
  // Reconstruct emitted text
  const reconstructed = seen.map(event => event.text ?? "").join("");
  expect(reconstructed).toBe("see [1] for details");
  expect(seen).toEqual([
    { type: "text_delta", text: "see [" },
    { type: "text_delta", text: "1] for details" },
  ]);
});

test("createHitlEmitFilter preserves each flushed event's phase across a multi-delta bracket buffer", () => {
  // Reproduces a lone "[" landing on a delta boundary (e.g. inside a markdown link like
  // "See [docs](url)"), which the filter holds back pending more text since "[" is a strict
  // prefix of "[EXEC_REQUEST". Once later text proves it was never a protocol block, the filter
  // must flush the buffered events verbatim -- phase and all -- rather than synthesizing a bare
  // `{ type: "text_delta", text }` that silently drops `phase` (bridge.ts closes/reopens output
  // items on a phase change, so a dropped phase fragments the transcript).
  type TestEvent = { type: string; text?: string; phase?: string };
  const seen: TestEvent[] = [];
  const filtered = createHitlEmitFilter<TestEvent>(event => seen.push(event));
  filtered({ type: "text_delta", text: "See ", phase: "final_answer" });
  filtered({ type: "text_delta", text: "[", phase: "final_answer" });
  filtered({ type: "text_delta", text: "docs](url) for details", phase: "final_answer" });
  filtered({ type: "text_delta", text: " more text", phase: "final_answer" });

  const reconstructed = seen.map(event => event.text ?? "").join("");
  expect(reconstructed).toBe("See [docs](url) for details more text");
  expect(seen.every(event => event.phase === "final_answer")).toBe(true);
  expect(seen).toEqual([
    { type: "text_delta", text: "See ", phase: "final_answer" },
    { type: "text_delta", text: "[", phase: "final_answer" },
    { type: "text_delta", text: "docs](url) for details", phase: "final_answer" },
    { type: "text_delta", text: " more text", phase: "final_answer" },
  ]);
});

test("createHitlEmitFilter handles EXEC_REQUEST split mid-token across calls", () => {
  const seen: unknown[] = [];
  const filtered = createHitlEmitFilter(event => seen.push(event));
  filtered({ type: "text_delta", text: "[EXEC_REQ" });
  filtered({ type: "text_delta", text: "UEST]\ncommand: ls\n[/EXEC_REQUEST]" });
  filtered({ type: "done" });
  // Should only see the done event, protocol block is withheld
  expect(seen).toEqual([{ type: "done" }]);
});

// --- Finding 5: an approved command must never spawn for a cancelled turn -------------------

test("createHitlExecGate finalizes without prompting when the turn is already aborted", async () => {
  let prompted = false;
  const controller = new AbortController();
  controller.abort();
  const gate = createHitlExecGate({
    approvalGateway: { request: async () => { prompted = true; return { action: "run", command: "echo hi" }; } },
    workspaceCwd: "/workspace",
    runCommand: async () => { throw new Error("runCommand must not be reached for an aborted turn"); },
  });
  expect(await gate.check("[EXEC_REQUEST]\ncommand: echo hi\n[/EXEC_REQUEST]", controller.signal))
    .toEqual({ action: "finalize" });
  expect(prompted).toBe(false);
});

test("createHitlExecGate never spawns the command when the turn is cancelled while the approval prompt is open", async () => {
  // Uses the REAL runApprovedCommand (no runCommand injection), so this asserts on an actual child
  // process: the approved command would create this marker file if it ever reached spawn().
  const workspace = mkdtempSync(join(tmpdir(), "hitl-abort-"));
  const marker = join(workspace, "spawned.txt");
  const controller = new AbortController();
  const gate = createHitlExecGate({
    approvalGateway: {
      // The operator takes their time; Codex cancels the turn while the prompt is still open.
      request: async () => {
        controller.abort();
        return { action: "run", command: `touch ${JSON.stringify(marker)}` };
      },
    },
    workspaceCwd: workspace,
  });
  const verdict = await gate.check("[EXEC_REQUEST]\ncommand: touch spawned.txt\n[/EXEC_REQUEST]", controller.signal);
  expect(verdict).toEqual({ action: "finalize" });
  expect(existsSync(marker)).toBe(false);
  rmSync(workspace, { recursive: true, force: true });
});

test("createHitlExecGate still resumes normally when the supplied signal never aborts", async () => {
  const controller = new AbortController();
  const gate = createHitlExecGate({
    approvalGateway: fakeGateway({ action: "run", command: "echo hi" }),
    workspaceCwd: "/workspace",
    runCommand: async () => "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]",
  });
  expect(await gate.check("[EXEC_REQUEST]\ncommand: echo hi\n[/EXEC_REQUEST]", controller.signal)).toEqual({
    action: "resume",
    followUpText: "[EXEC_RESULT]\nexit_code: 0\noutput:\nhi\n[/EXEC_RESULT]",
  });
});

// --- Finding 3: concurrent turns must not open two readline interfaces on one stdin ----------

test("HitlApprovalQueue serializes concurrent approvals and stamps each proposal with its turn id", async () => {
  let live = 0;
  let maxLive = 0;
  const seen: ExecProposal[] = [];
  const gateway: ApprovalGateway = {
    request: async proposal => {
      seen.push(proposal);
      live += 1;
      maxLive = Math.max(maxLive, live);
      await new Promise(resolve => setTimeout(resolve, 15));
      live -= 1;
      return { action: "run", command: proposal.command };
    },
  };
  const queue = new HitlApprovalQueue(gateway);
  const decisions = await Promise.all([
    queue.forTurn("trace-a").request({ command: "a", cwd: "/w" }),
    queue.forTurn("trace-b").request({ command: "b", cwd: "/w" }),
    queue.forTurn("trace-c").request({ command: "c", cwd: "/w" }),
  ]);
  expect(maxLive).toBe(1);
  expect(seen.map(proposal => proposal.traceId)).toEqual(["trace-a", "trace-b", "trace-c"]);
  expect(decisions).toEqual([
    { action: "run", command: "a" },
    { action: "run", command: "b" },
    { action: "run", command: "c" },
  ]);
});

test("HitlApprovalQueue keeps draining after one prompt fails", async () => {
  let calls = 0;
  const queue = new HitlApprovalQueue({
    request: async proposal => {
      calls += 1;
      if (proposal.command === "boom") throw new Error("prompt failed");
      return { action: "run", command: proposal.command };
    },
  });
  const failing = queue.forTurn("t1").request({ command: "boom", cwd: "/w" });
  const following = queue.forTurn("t2").request({ command: "ok", cwd: "/w" });
  await expect(failing).rejects.toThrow("prompt failed");
  await expect(following).resolves.toEqual({ action: "run", command: "ok" });
  expect(calls).toBe(2);
});
