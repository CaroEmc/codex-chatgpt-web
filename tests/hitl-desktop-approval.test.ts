import { expect, test } from "bun:test";
import { withDesktopApproval } from "../src/adapters/chatgpt-web/hitl-desktop-approval";
import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../src/hitl/approval";

const proposal: ExecProposal = { command: "ls -la", cwd: "/workspace", reason: "List files", traceId: "abc123def456" };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("terminal wins: returns its decision and cancels the popup", async () => {
  const cancelCalls: [string, string][] = [];
  const deps = {
    requestLauncherHitlDecision: () => new Promise<ApprovalDecision>(() => {}), // never resolves
    notifyLauncherHitlCancelled: async (descriptorPath: string, requestId: string) => {
      cancelCalls.push([descriptorPath, requestId]);
    },
  };
  const terminalDecision: ApprovalDecision = { action: "run", command: "ls -la" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
  expect(cancelCalls.length).toBe(1);
  expect(cancelCalls[0]?.[0]).toBe("/tmp/launcher-browser.json");
  expect(cancelCalls[0]?.[1]).toMatch(UUID_PATTERN);
});

test("mints a fresh requestId per request rather than forwarding the proposal's traceId", async () => {
  const seen: unknown[] = [];
  const deps = {
    requestLauncherHitlDecision: (_descriptorPath: string, proposal: unknown) => {
      seen.push(proposal);
      return new Promise<ApprovalDecision>(() => {});
    },
    notifyLauncherHitlCancelled: async () => {},
  };
  const inner: ApprovalGateway = { request: async () => ({ action: "reject" }) };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  await wrapped.request(proposal);
  expect(seen.length).toBe(1);
  const forwarded = seen[0] as { requestId?: string };
  expect(typeof forwarded.requestId).toBe("string");
  expect(forwarded.requestId).toMatch(UUID_PATTERN);
  expect(forwarded.requestId).not.toBe(proposal.traceId);
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

test("popup competitor rejecting: terminal's decision still wins cleanly", async () => {
  const deps = {
    requestLauncherHitlDecision: () => Promise.reject(new Error("launcher unreachable")),
    notifyLauncherHitlCancelled: async () => {},
  };
  const terminalDecision: ApprovalDecision = { action: "run", command: "ls -la" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = withDesktopApproval(inner, "/tmp/launcher-browser.json", deps);
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
});
