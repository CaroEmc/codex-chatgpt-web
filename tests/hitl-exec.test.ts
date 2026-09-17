import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoApproveGateway, type ApprovalGateway, type ApprovalDecision, type ExecProposal } from "../src/hitl/approval";
import { EXEC_REJECTED_TEXT, formatCwdOutsideWorkspace } from "../src/hitl/protocol";
import { composerSafeOutput, HITL_EXEC_DEFAULT_TIMEOUT_MS, HITL_EXEC_TIMEOUT_MS, runApprovedCommand } from "../src/hitl/exec";

class FixedGateway implements ApprovalGateway {
  seen: ExecProposal[] = [];
  constructor(private readonly decision: ApprovalDecision) {}
  async request(proposal: ExecProposal): Promise<ApprovalDecision> {
    this.seen.push(proposal);
    return this.decision;
  }
}

test("an approved command runs and its output is wrapped in EXEC_RESULT", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const cmd = process.platform === "win32" ? "bun -e \"process.stdout.write('hello')\"" : "printf hello";
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace);
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 0\noutput:\nhello\n[/EXEC_RESULT]");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a rejected command returns the literal rejection text and never spawns", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "reject" });
    const result = await runApprovedCommand(gateway, { command: "printf should-not-run" }, workspace);
    expect(result).toBe(EXEC_REJECTED_TEXT);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a nonzero exit code is reported in the EXEC_RESULT block", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "exit 3" });
    const result = await runApprovedCommand(gateway, { command: "exit 3" }, workspace);
    expect(result).toContain("exit_code: 3");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("output beyond 10KB is truncated", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
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
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd", cwd: "." }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a cwd escaping the workspace is rejected before reaching approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    const result = await runApprovedCommand(gateway, { command: "pwd", cwd: "../../etc" }, workspace);
    expect(result).toBe(formatCwdOutsideWorkspace("../../etc", workspace));
    expect(result).not.toBe(EXEC_REJECTED_TEXT);
    expect(result).toContain(workspace);
    expect(gateway.seen).toHaveLength(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an absolute cwd outside the workspace is blocked with guidance to use a relative path", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "ls" });
    const result = await runApprovedCommand(gateway, { command: "ls", cwd: "/doc" }, workspace);
    expect(result).toContain("did not reject");
    expect(result).toContain("relative");
    expect(gateway.seen).toHaveLength(0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a gateway that throws is treated as a rejection and never crashes the caller", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
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
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new FixedGateway({ action: "run", command: "pwd" });
    await runApprovedCommand(gateway, { command: "pwd" }, workspace);
    expect(gateway.seen[0]!.cwd).toBe(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("the exec timeout has enough margin for a delegated codex exec sub-task, not just a plain shell command", () => {
  // Two real occurrences of a delegated `codex exec` sub-task (per the HITL protocol's subagent
  // guidance) show wildly different durations: 60,886ms, then 290,779ms -- a genuine review's
  // length varies a lot with scope, not a single worst case to pad slightly. Doubling the timeout
  // once already proved insufficient (the second occurrence blew past the 120,000ms bound it
  // motivated). The channel is human-approval-gated -- nothing runs unsupervised, and the human
  // already watched the command start -- so a generous ceiling costs little for the ordinary short
  // commands that dominate this channel, while giving real headroom for multi-minute delegated
  // reviews instead of incrementally re-bumping on every larger real occurrence.
  expect(HITL_EXEC_TIMEOUT_MS).toBe(600_000);
  expect(HITL_EXEC_TIMEOUT_MS).toBeGreaterThan(290_779);
});

test("AutoApproveGateway runs the proposed command and echoes it", async () => {
  const written: string[] = [];
  const output = { write: (chunk: string) => { written.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
  const gateway = new AutoApproveGateway(output);
  const decision = await gateway.request({ command: "rg -l libbff doc", cwd: "D:/work", reason: "search", traceId: "t1" });
  expect(decision).toEqual({ action: "run", command: "rg -l libbff doc" });
  expect(written.join("")).toContain("auto-approved (turn t1): rg -l libbff doc");
});

test("AutoApproveGateway still rejects a proposal whose turn is already cancelled", async () => {
  const gateway = new AutoApproveGateway({ write: () => true } as unknown as NodeJS.WritableStream);
  const controller = new AbortController();
  controller.abort();
  expect(await gateway.request({ command: "ls", cwd: "." }, controller.signal)).toEqual({ action: "reject" });
});

test("an auto-approved command is still confined to the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const gateway = new AutoApproveGateway({ write: () => true } as unknown as NodeJS.WritableStream);
    const result = await runApprovedCommand(gateway, { command: "ls", cwd: "../.." }, workspace);
    expect(result).toContain("outside the workspace root");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CRLF command output is normalized so the ChatGPT composer preserves the follow-up verbatim", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const cmd = "bun -e \"process.stdout.write('a.md' + String.fromCharCode(13, 10) + 'b.md' + String.fromCharCode(13, 10))\"";
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace);
    expect(result).toBe("[EXEC_RESULT]\nexit_code: 0\noutput:\na.md\nb.md\n\n[/EXEC_RESULT]");
    expect(result).not.toContain(String.fromCharCode(13));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a multi-byte character split across output chunks is decoded intact", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const script = "const b=Buffer.from('文件.md');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),50)";
    const cmd = `bun -e "${script}"`;
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace);
    expect(result).toContain("output:\n文件.md\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("composerSafeOutput rewrites characters the ChatGPT composer would silently substitute", () => {
  const cr = String.fromCharCode(13);
  const input = ["a", cr, "\n", "\t", "b", "\u00A0", "\u3000", "c", "\uFEFF", "\u200B", "d", "\x1b[31m", "e", "\x07"].join("");
  expect(composerSafeOutput(input)).toBe("a\n    b  cde");
  expect(composerSafeOutput("文件.md\n")).toBe("文件.md\n");
});

test("a command that falls back to reading stdin sees EOF instead of hanging", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const cmd = `bun -e "process.stdin.resume();process.stdin.on('end',()=>console.log('stdin-eof'))"`;
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const started = Date.now();
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace, { timeoutMs: 15_000 });
    expect(result).toContain("stdin-eof");
    expect(result).toContain("exit_code: 0");
    expect(Date.now() - started).toBeLessThan(10_000);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a timeout kills the whole process tree, not just the shell", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const marker = join(workspace, "grandchild-survived.txt");
    const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),3000)`;
    const parent = `const c=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
    const script = join(workspace, "parent.cjs");
    writeFileSync(script, parent);
    const cmd = `bun ${JSON.stringify(script)}`;
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace, { timeoutMs: 1_000 });
    expect(result).toContain("exit_code: 124");
    expect(result).toContain("timed out after 1000ms");
    await new Promise(resolveWait => setTimeout(resolveWait, 4_000));
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 20_000);

test("a request's timeout field bounds that command instead of the 10-minute ceiling", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const cmd = `bun -e "setTimeout(() => {}, 20000)"`;
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const lines: string[] = [];
    const started = Date.now();
    const result = await runApprovedCommand(gateway, { command: cmd, timeoutSeconds: 1 }, workspace, {
      report: line => lines.push(line),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toContain("exit_code: 124");
    expect(result).toContain("timed out after 1000ms");
    expect(result).toContain("set a longer timeout");
    expect(lines.some(line => line.includes("stopping after 1s"))).toBe(true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 20_000);

test("a long-running command is reported periodically on the daemon terminal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "hitl-exec-"));
  try {
    const cmd = `bun -e "setTimeout(() => console.log('done'), 1500)"`;
    const gateway = new FixedGateway({ action: "run", command: cmd });
    const lines: string[] = [];
    const result = await runApprovedCommand(gateway, { command: cmd }, workspace, {
      progressIntervalMs: 300,
      report: line => lines.push(line),
    });
    expect(result).toContain("exit_code: 0");
    expect(result).toContain("done");
    expect(lines.some(line => line.startsWith("[hitl] still running after") && line.includes(cmd))).toBe(true);
    const count = lines.length;
    await new Promise(resolveWait => setTimeout(resolveWait, 700));
    expect(lines.length).toBe(count);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}, 20_000);

test("the default timeout for a request without a timeout field is much shorter than the ceiling", () => {
  expect(HITL_EXEC_DEFAULT_TIMEOUT_MS).toBe(60_000);
  expect(HITL_EXEC_DEFAULT_TIMEOUT_MS).toBeLessThan(HITL_EXEC_TIMEOUT_MS);
});
