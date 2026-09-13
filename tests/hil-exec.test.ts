import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalGateway, ApprovalDecision, ExecProposal } from "../src/dev-chat/hil-approval";
import { EXEC_REJECTED_TEXT } from "../src/dev-chat/hil-protocol";
import { runApprovedCommand } from "../src/dev-chat/hil-exec";

class FixedGateway implements ApprovalGateway {
  seen: ExecProposal[] = [];
  constructor(private readonly decision: ApprovalDecision) {}
  async request(proposal: ExecProposal): Promise<ApprovalDecision> {
    this.seen.push(proposal);
    return this.decision;
  }
}

test("an approved command runs and its output is wrapped in EXEC_RESULT", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "printf hello" });
    const result = await runApprovedCommand(gateway, { command: "printf hello" }, workspace);
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 0\noutput:\nhello\n[/EXEC_RESULT]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a rejected command returns the literal rejection text and never spawns", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "reject" });
    const result = await runApprovedCommand(gateway, { command: "printf should-not-run" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a nonzero exit code is reported in the EXEC_RESULT block", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "exit 3" });
    const result = await runApprovedCommand(gateway, { command: "exit 3" }, workspace);
    expect(result).toContain("exit_code: 3");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("output beyond 10KB is truncated", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "yes x | head -c 20000" });
    const result = await runApprovedCommand(gateway, { command: "yes x | head -c 20000" }, workspace);
    const output = result.slice(result.indexOf("output:\n") + "output:\n".length, -"\n[/EXEC_RESULT]".length);
    expect(output.length).toBeLessThanOrEqual(10 * 1024);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a relative cwd is resolved against the workspace and passed through to the gateway", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd", cwd: "." }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cwd escaping the workspace is rejected before reaching approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    const result = await runApprovedCommand(gateway, { command: "pwd", cwd: "../../etc" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
    expect(gateway.seen).toHaveLength(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a gateway that throws is treated as a rejection and never crashes the caller", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    class ThrowingGateway implements ApprovalGateway {
      async request(): Promise<ApprovalDecision> {
        throw new Error("socket disconnected");
      }
    }
    const gateway = new ThrowingGateway();
    const result = await runApprovedCommand(gateway, { command: "printf should-not-run" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an omitted cwd defaults to the workspace root", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hil-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd" }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
