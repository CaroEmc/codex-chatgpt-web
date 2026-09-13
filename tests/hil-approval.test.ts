import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { TtyApprovalGateway } from "../src/dev-chat/hil-approval";

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

test("an unattended non-TTY stream rejects without prompting", async () => {
  const { input, output } = fakeTty(false);
  const gateway = new TtyApprovalGateway(input, output);
  await expect(gateway.request(proposal)).resolves.toEqual({ action: "reject" });
  expect(output.readableLength).toBe(0);
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
