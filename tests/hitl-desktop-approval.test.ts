import { expect, test } from "bun:test";
import { withDesktopApproval } from "../src/adapters/chatgpt-web/hitl-desktop-approval";
import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../src/hitl/approval";

const proposal: ExecProposal = { command: "ls -la", cwd: "/workspace", reason: "List files", traceId: "abc123def456" };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("terminal wins: returns its decision and cancels the popup", async () => {
  const cancelCalls: [string, string][] = [];
  const deps = {
    requestLauncherHitlDecision: () => new Promise<ApprovalDecision>(() => {}), // never resolves
    notifyLauncherHitlCancelled: async (descriptorPath: string, traceId: string) => {
      cancelCalls.push([descriptorPath, traceId]);
    },
  };
  const terminalDecision: ApprovalDecision = { action: "run", command: "ls -la" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
  expect(cancelCalls).toEqual([["/tmp/launcher-browser.json", "abc123def456"]]);
});

test("popup wins: returns its decision and aborts the terminal's signal", async () => {
  const popup = deferred<ApprovalDecision>();
  const deps = {
    requestLauncherHitlDecision: () => popup.promise,
    notifyLauncherHitlCancelled: async () => {},
  };
  let terminalSignal: AbortSignal | undefined;
  const inner: ApprovalGateway = {
    request: (_proposal, signal) => {
      terminalSignal = signal;
      return new Promise<ApprovalDecision>(() => {}); // never resolves on its own
    },
  };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  const result = wrapped.request(proposal);
  popup.resolve({ action: "reject" });
  await expect(result).resolves.toEqual({ action: "reject" });
  expect(terminalSignal?.aborted).toBe(true);
});

test("popup unreachable: still returns the terminal's decision", async () => {
  const deps = {
    requestLauncherHitlDecision: () => new Promise<ApprovalDecision>(() => {}),
    notifyLauncherHitlCancelled: async () => {},
  };
  const terminalDecision: ApprovalDecision = { action: "reject" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
});
