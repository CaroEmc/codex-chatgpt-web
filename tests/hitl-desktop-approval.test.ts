import { expect, mock, test } from "bun:test";
import { withDesktopApproval } from "../src/adapters/chatgpt-web/hitl-desktop-approval";
import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../src/hitl/approval";

const proposal: ExecProposal = { command: "ls -la", cwd: "/workspace", reason: "List files", traceId: "abc123def456" };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

test("terminal wins: returns its decision and cancels the popup", async () => {
  const cancel = mock(async () => {});
  mock.module("../src/launcher-browser-host", () => ({
    requestLauncherHitlDecision: () => new Promise<ApprovalDecision>(() => {}), // never resolves
    notifyLauncherHitlCancelled: cancel,
  }));
  const { withDesktopApproval: freshWrap } = await import("../src/adapters/chatgpt-web/hitl-desktop-approval");
  const terminalDecision: ApprovalDecision = { action: "run", command: "ls -la" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = freshWrap(inner, "/tmp/launcher-browser.json");
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
  expect(cancel).toHaveBeenCalledWith("/tmp/launcher-browser.json", "abc123def456");
});

test("popup wins: returns its decision and aborts the terminal's signal", async () => {
  const popup = deferred<ApprovalDecision>();
  mock.module("../src/launcher-browser-host", () => ({
    requestLauncherHitlDecision: () => popup.promise,
    notifyLauncherHitlCancelled: async () => {},
  }));
  const { withDesktopApproval: freshWrap } = await import("../src/adapters/chatgpt-web/hitl-desktop-approval");
  let terminalSignal: AbortSignal | undefined;
  const inner: ApprovalGateway = {
    request: (_proposal, signal) => {
      terminalSignal = signal;
      return new Promise<ApprovalDecision>(() => {}); // never resolves on its own
    },
  };
  const wrapped = freshWrap(inner, "/tmp/launcher-browser.json");
  const result = wrapped.request(proposal);
  popup.resolve({ action: "reject" });
  await expect(result).resolves.toEqual({ action: "reject" });
  expect(terminalSignal?.aborted).toBe(true);
});

test("popup unreachable: still returns the terminal's decision", async () => {
  mock.module("../src/launcher-browser-host", () => ({
    requestLauncherHitlDecision: () => new Promise<ApprovalDecision>(() => {}),
    notifyLauncherHitlCancelled: async () => {},
  }));
  const { withDesktopApproval: freshWrap } = await import("../src/adapters/chatgpt-web/hitl-desktop-approval");
  const terminalDecision: ApprovalDecision = { action: "reject" };
  const inner: ApprovalGateway = { request: async () => terminalDecision };
  const wrapped = freshWrap(inner, "/tmp/launcher-browser.json");
  await expect(wrapped.request(proposal)).resolves.toEqual(terminalDecision);
});
