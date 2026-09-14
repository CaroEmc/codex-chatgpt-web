import { expect, test } from "bun:test";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { TtyApprovalGateway } from "../src/hitl/approval";

function fakeTty(isTTY: boolean): { input: PassThrough & { isTTY?: boolean }; output: PassThrough; written: () => string } {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = isTTY;
  const output = new PassThrough();
  let buffer = "";
  output.on("data", chunk => { buffer += chunk.toString(); });
  return { input, output, written: () => buffer };
}

const proposal = { command: "git status -s", cwd: "/workspace/project", reason: "Check status" };

test("Enter/y runs the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("y (explicit) runs the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("y\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("n rejects", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("n\n");
  await expect(decision).resolves.toEqual({ action: "reject" });
});

test("c edits the command before running", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("c\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write("git status --porcelain\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status --porcelain" });
});

test("c with an empty replacement keeps the original command", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("c\n");
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write("\n");
  await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });
});

test("unrecognized input rejects rather than running (fails closed)", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("garbage\n");
  await expect(decision).resolves.toEqual({ action: "reject" });
});

test("esc rejects", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  input.write("esc\n");
  await expect(decision).resolves.toEqual({ action: "reject" });
});

test("an abort signal interrupts a pending prompt and rejects", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const controller = new AbortController();
  const decision = gateway.request(proposal, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await expect(decision).resolves.toEqual({ action: "reject" });
  // A stray answer arriving after the abort must not be mistaken for a real decision.
  input.write("y\n");
  await new Promise(resolve => setTimeout(resolve, 10));
});

test("an already-aborted signal rejects without prompting", async () => {
  const { input, output } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const controller = new AbortController();
  controller.abort();
  await expect(gateway.request(proposal, controller.signal)).resolves.toEqual({ action: "reject" });
});

test("an unattended non-TTY stream rejects without prompting", async () => {
  const { input, output } = fakeTty(false);
  const gateway = new TtyApprovalGateway(input, output);
  await expect(gateway.request(proposal)).resolves.toEqual({ action: "reject" });
  expect(output.readableLength).toBe(0);
});

test("a shared readline.Interface lets a REPL prompt and a mid-session approval prompt both resolve, with no second reader opened on stdin", async () => {
  // Reproduces the scenario that used to hang the interactive REPL: an outer readline
  // prompt (simulating cli.ts's interactive() loop) reads a line, then an approval
  // gateway question happens mid-session sharing the SAME readline.Interface, then the
  // outer prompt reads another line successfully afterward. Previously the gateway opened
  // its OWN readline.Interface on the same stdin, and two concurrent interfaces on one
  // stream corrupted each other so the REPL's next prompt never resolved.
  const { input, output } = fakeTty(true);
  const reader = createInterface({ input, output });
  try {
    const firstReplLine = reader.question("repl> ");
    input.write("first message\n");
    await expect(firstReplLine).resolves.toBe("first message");

    const gateway = new TtyApprovalGateway(input, output, reader);
    const decision = gateway.request(proposal);
    input.write("y\n");
    await expect(decision).resolves.toEqual({ action: "run", command: "git status -s" });

    const secondReplLine = reader.question("repl> ");
    input.write("second message\n");
    await expect(secondReplLine).resolves.toBe("second message");
  } finally {
    reader.close();
  }
});

test("a proposal carrying a traceId labels the prompt with the requesting turn", async () => {
  // Concurrent daemon HITL turns share one terminal; without the turn label an operator cannot
  // tell which turn is asking. Single-session callers (dev chat) pass no traceId and see no line.
  const { input, output, written } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request({ ...proposal, traceId: "trace_abc123" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(written()).toContain("Turn   : trace_abc123");
  input.write("n\n");
  await decision;
});

test("a proposal without a traceId renders exactly as before (dev chat is unchanged)", async () => {
  const { input, output, written } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(written()).not.toContain("Turn   :");
  expect(written().split("\n")[1]).toBe("Reason : Check status");
  input.write("n\n");
  await decision;
});

test("the proposal box is rendered before a decision arrives", async () => {
  const { input, output, written } = fakeTty(true);
  const gateway = new TtyApprovalGateway(input, output);
  const decision = gateway.request(proposal);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(written()).toContain("git status -s");
  expect(written()).toContain("/workspace/project");
  expect(written()).toContain("Check status");
  input.write("n\n");
  await decision;
});
