# HITL Interactive Popup Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain, non-interactive desktop notification for a pending HITL approval with a real interactive popup window, usable on Linux/macOS/Windows, that races against the terminal prompt for the operator's decision.

**Architecture:** A racing `ApprovalGateway` wrapper starts the existing terminal prompt and a new bounded-long-poll HTTP call to the launcher concurrently; whichever answers first wins via `Promise.race`, and the loser is actively cancelled. The launcher opens a small `BrowserWindow` popup on request and resolves the poll once the operator clicks Run/Reject or closes the window.

**Tech Stack:** TypeScript (daemon side, Bun test), CommonJS + Electron (launcher side, `node:test`).

**Spec:** `docs/superpowers/specs/2026-09-15-hitl-interactive-popup-approval-design.md`

## Global Constraints

- Popup content is set via `textContent`/`.value` only — never HTML-templated from proposal text (XSS guard against model-controlled command/reason text).
- The popup's `webContents` must use `contextIsolation: true`, `nodeIntegration: false`, and its own minimal preload — never the main app's `preload.cjs`.
- `requestLauncherHitlDecision` and the racing wrapper's failure paths must never *reject* — only ever resolve-late or never-resolve — so a broken launcher can never win the race with a bad outcome.
- The server's bounded-wait timeout must stay below the client's per-request fetch timeout, matching the existing manual-turn constants' relationship (`LAUNCHER_MANUAL_SENT_REQUEST_TIMEOUT_MS` vs. the server's `MANUAL_SENT_OBSERVER_TIMEOUT_MS`).
- This replaces `hitl-desktop-notify.ts` / `notifyLauncherHitlApprovalPending` / `POST /v1/notify/hitl-pending` / `notifyHitlApprovalPending` entirely — they are removed, not left alongside the new mechanism.

---

### Task 1: Daemon-side client for the popup decision channel

**Files:**
- Modify: `src/launcher-browser-host.ts`
- Modify: `tests/launcher-browser-host.test.ts`

**Interfaces:**
- Produces: `LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS: number`, `requestLauncherHitlDecision(descriptorPath: string, proposal: { traceId: string; command: string; cwd: string; reason?: string }, signal?: AbortSignal): Promise<{ action: "run"; command: string } | { action: "reject" }>`, `notifyLauncherHitlCancelled(descriptorPath: string, traceId: string): Promise<void>` — Task 2 imports both.
- Consumes: `readLauncherBrowserHostDescriptor` (already in this file).

- [ ] **Step 1: Remove the superseded notify-only client**

  Delete `LAUNCHER_HITL_NOTIFY_TIMEOUT_MS` and `notifyLauncherHitlApprovalPending` from `src/launcher-browser-host.ts` (added by the earlier plain-notification change; this popup mechanism replaces it).

  In `tests/launcher-browser-host.test.ts`, delete the three tests named `"launcher HITL notification sends an authenticated best-effort request"`, `"launcher HITL notification never throws when the launcher is unreachable"`, and `"launcher HITL notification never throws for a missing descriptor"`, and remove `notifyLauncherHitlApprovalPending` from the import list.

  Run: `bun test tests/launcher-browser-host.test.ts`
  Expected: passes (fewer tests than before; nothing else references the removed export yet).

- [ ] **Step 2: Write the failing test for a decided response**

  Add to `tests/launcher-browser-host.test.ts` (uses the existing `descriptorFile` helper already in this file):

  ```ts
  test("launcher HITL decision resolves once the server returns a decision", async () => {
    let received: { url?: string; body?: unknown; authorization?: string } = {};
    let callCount = 0;
    const server = createServer(async (request, response) => {
      callCount += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = {
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(callCount === 1 ? 202 : 200, { "content-type": "application/json" });
      response.end(callCount === 1
        ? '{"status":"pending"}\n'
        : '{"ok":true,"action":"run","command":"ls -la --edited"}\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      const path = descriptorFile(`http://127.0.0.1:${address.port}`);
      await expect(requestLauncherHitlDecision(path, {
        traceId: "abc123def456",
        command: "ls -la",
        cwd: "/workspace",
        reason: "List files",
      })).resolves.toEqual({ action: "run", command: "ls -la --edited" });
      expect(callCount).toBe(2);
      expect(received).toEqual({
        url: "/v1/hitl/decide",
        authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
        body: { traceId: "abc123def456", command: "ls -la", cwd: "/workspace", reason: "List files" },
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test("launcher HITL decision never resolves when the launcher is unreachable", async () => {
    const path = descriptorFile("http://127.0.0.1:1");
    const decided = requestLauncherHitlDecision(path, {
      traceId: "abc123def456", command: "ls -la", cwd: "/workspace",
    });
    const raced = await Promise.race([
      decided.then(() => "decided"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 300)),
    ]);
    expect(raced).toBe("timeout");
  });

  test("launcher HITL decision never resolves once its own signal is already aborted", async () => {
    const path = descriptorFile("http://127.0.0.1:1");
    const controller = new AbortController();
    controller.abort();
    const decided = requestLauncherHitlDecision(path, {
      traceId: "abc123def456", command: "ls -la", cwd: "/workspace",
    }, controller.signal);
    const raced = await Promise.race([
      decided.then(() => "decided"),
      new Promise(resolve => setTimeout(() => resolve("timeout"), 300)),
    ]);
    expect(raced).toBe("timeout");
  });

  test("launcher HITL cancel sends an authenticated best-effort request and never throws", async () => {
    let received: { url?: string; body?: unknown } = {};
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = { url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      const path = descriptorFile(`http://127.0.0.1:${address.port}`);
      await notifyLauncherHitlCancelled(path, "abc123def456");
      expect(received).toEqual({ url: "/v1/hitl/decide/cancel", body: { traceId: "abc123def456" } });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await expect(notifyLauncherHitlCancelled("/nonexistent/launcher-browser.json", "abc123def456"))
      .resolves.toBeUndefined();
  });
  ```

  Add `requestLauncherHitlDecision, notifyLauncherHitlCancelled` to the import from `"../src/launcher-browser-host"`.

  Run: `bun test tests/launcher-browser-host.test.ts`
  Expected: FAIL — `requestLauncherHitlDecision`/`notifyLauncherHitlCancelled` are not exported yet.

- [ ] **Step 3: Implement the client functions**

  Add to `src/launcher-browser-host.ts`:

  ```ts
  export const LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS = 40_000;

  export interface LauncherHitlProposal {
    traceId: string;
    command: string;
    cwd: string;
    reason?: string;
  }

  export type LauncherHitlDecision = { action: "run"; command: string } | { action: "reject" };

  /** Never rejects: any failure (launcher unreachable, bad response, an already-aborted signal)
   * resolves a promise that never settles, so this can never win a Promise.race with a bad
   * outcome -- its only two valid outcomes are "the popup produced a real decision" or "silently
   * defer to whichever other approval source is racing it". */
  export async function requestLauncherHitlDecision(
    descriptorPath: string,
    proposal: LauncherHitlProposal,
    signal?: AbortSignal,
    timeoutMs = LAUNCHER_HITL_DECIDE_REQUEST_TIMEOUT_MS,
  ): Promise<LauncherHitlDecision> {
    for (;;) {
      if (signal?.aborted) return await new Promise<LauncherHitlDecision>(() => {});
      let response: Response;
      try {
        const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          response = await fetch(`${descriptor.control.endpoint}/v1/hitl/decide`, {
            method: "POST",
            headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
            body: JSON.stringify(proposal),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      } catch {
        return await new Promise<LauncherHitlDecision>(() => {});
      }
      if (response.status === 202) continue;
      if (!response.ok) return await new Promise<LauncherHitlDecision>(() => {});
      const body = await response.json().catch(() => undefined) as
        | { ok: true; action: "run"; command: string }
        | { ok: true; action: "reject" }
        | undefined;
      if (!body?.ok) return await new Promise<LauncherHitlDecision>(() => {});
      return body.action === "run" ? { action: "run", command: body.command } : { action: "reject" };
    }
  }

  /** Best-effort: tells the launcher to close a still-open popup for `traceId` because the
   * terminal already answered. Never throws -- there is nothing useful to do with a failure here
   * other than leave a popup open a little longer than ideal. */
  export async function notifyLauncherHitlCancelled(descriptorPath: string, traceId: string): Promise<void> {
    try {
      const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        await fetch(`${descriptor.control.endpoint}/v1/hitl/decide/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${descriptor.control.token}`, "content-type": "application/json" },
          body: JSON.stringify({ traceId }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Best-effort.
    }
  }
  ```

  Run: `bun test tests/launcher-browser-host.test.ts`
  Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

  Run: `bun run typecheck`
  Expected: clean.

  ```bash
  git add src/launcher-browser-host.ts tests/launcher-browser-host.test.ts
  git commit -m "feat: add the daemon-side client for the HITL popup decision channel"
  ```

---

### Task 2: Racing approval gateway wrapper

**Files:**
- Delete: `src/adapters/chatgpt-web/hitl-desktop-notify.ts`
- Delete: `tests/hitl-desktop-notify.test.ts`
- Create: `src/adapters/chatgpt-web/hitl-desktop-approval.ts`
- Create: `tests/hitl-desktop-approval.test.ts`
- Modify: `src/adapters/chatgpt-web/index.ts`

**Interfaces:**
- Consumes: `requestLauncherHitlDecision`, `notifyLauncherHitlCancelled` (Task 1), `ApprovalDecision`/`ApprovalGateway`/`ExecProposal` (`src/hitl/approval.ts`, unchanged).
- Produces: `withDesktopApproval(gateway: ApprovalGateway, descriptorPath: string): ApprovalGateway` — `index.ts` wires this in place of `withDesktopNotify`.

- [ ] **Step 1: Delete the superseded notify-only wrapper and its test**

  ```bash
  git rm src/adapters/chatgpt-web/hitl-desktop-notify.ts tests/hitl-desktop-notify.test.ts
  ```

- [ ] **Step 2: Write the failing tests**

  Create `tests/hitl-desktop-approval.test.ts`:

  ```ts
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
  ```

  Run: `bun test tests/hitl-desktop-approval.test.ts`
  Expected: FAIL — `src/adapters/chatgpt-web/hitl-desktop-approval.ts` does not exist yet.

- [ ] **Step 3: Implement the racing wrapper**

  Create `src/adapters/chatgpt-web/hitl-desktop-approval.ts`:

  ```ts
  import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../../hitl/approval";
  import { notifyLauncherHitlCancelled, requestLauncherHitlDecision } from "../../launcher-browser-host";

  /** Wraps an `ApprovalGateway` so a HITL approval prompt can be answered either from the wrapped
   * gateway (the daemon's own terminal) or from a popup window the launcher opens -- whichever the
   * operator answers first wins. The loser is actively cancelled: the terminal's own abort signal
   * closes its readline prompt, and a best-effort cancel call closes a still-open popup. */
  export function withDesktopApproval(gateway: ApprovalGateway, descriptorPath: string): ApprovalGateway {
    return {
      async request(proposal: ExecProposal, signal?: AbortSignal): Promise<ApprovalDecision> {
        const race = new AbortController();
        const onOuterAbort = () => race.abort();
        signal?.addEventListener("abort", onOuterAbort, { once: true });
        const traceId = proposal.traceId ?? "untraced";
        try {
          return await Promise.race([
            gateway.request(proposal, race.signal),
            requestLauncherHitlDecision(
              descriptorPath,
              { traceId, command: proposal.command, cwd: proposal.cwd, reason: proposal.reason },
              race.signal,
            ),
          ]);
        } finally {
          race.abort();
          signal?.removeEventListener("abort", onOuterAbort);
          void notifyLauncherHitlCancelled(descriptorPath, traceId);
        }
      },
    };
  }
  ```

  Run: `bun test tests/hitl-desktop-approval.test.ts`
  Expected: PASS.

- [ ] **Step 4: Wire into index.ts**

  In `src/adapters/chatgpt-web/index.ts`, replace:

  ```ts
  import { withDesktopNotify } from "./hitl-desktop-notify";
  ```

  with:

  ```ts
  import { withDesktopApproval } from "./hitl-desktop-approval";
  ```

  and replace:

  ```ts
  const hitlApprovals = hitlActive
    ? new HitlApprovalQueue(
      retainedLauncherDescriptor
        ? withDesktopNotify(hitlApprovalGateway, retainedLauncherDescriptor)
        : hitlApprovalGateway,
    )
    : undefined;
  ```

  with:

  ```ts
  const hitlApprovals = hitlActive
    ? new HitlApprovalQueue(
      retainedLauncherDescriptor
        ? withDesktopApproval(hitlApprovalGateway, retainedLauncherDescriptor)
        : hitlApprovalGateway,
    )
    : undefined;
  ```

  Run: `bun run typecheck && bun test tests/chatgpt-web-hitl-wiring.test.ts`
  Expected: clean; existing wiring tests unaffected (they exercise the gate/IPC path, not this wrapper).

- [ ] **Step 5: Commit**

  ```bash
  git add -A src/adapters/chatgpt-web/hitl-desktop-approval.ts tests/hitl-desktop-approval.test.ts src/adapters/chatgpt-web/index.ts
  git commit -m "feat: race the terminal HITL prompt against a launcher popup decision"
  ```

---

### Task 3: Main-process popup controller

**Files:**
- Create: `launcher/electron/hitl-popup.cjs`
- Create: `launcher/electron/hitl-popup.html`
- Create: `launcher/electron/hitl-popup-preload.cjs`
- Create: `launcher/tests/hitl-popup.test.cjs`

**Interfaces:**
- Produces: `class HitlPopupController` with `constructor({ BrowserWindow, htmlPath, preloadPath, iconPath, logger })` and methods `requestDecision(traceId, proposal): void` (fire-and-forget: opens or no-ops if already open for `traceId`), `waitForDecision(traceId, timeoutMs): Promise<{ status: "decided"; decision } | { status: "pending" }>`, `cancel(traceId): void`. Task 4 constructs one instance and passes it as `hitlApproval` to `BrowserControlServer`.

- [ ] **Step 1: Write the failing tests**

  Create `launcher/tests/hitl-popup.test.cjs`. This fakes `BrowserWindow` the same way `runtime-supervisor.test.cjs` fakes Electron's `app` (a plain object matching only the surface this code touches — no real Electron dependency in the test):

  ```js
  const test = require("node:test");
  const assert = require("node:assert/strict");
  const { EventEmitter } = require("node:events");
  const { HitlPopupController } = require("../electron/hitl-popup.cjs");

  function fakeWindowFactory() {
    const created = [];
    class FakeWindow extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.webContents = new EventEmitter();
        this.webContents.send = (...args) => this.sent.push(args);
        this.sent = [];
        this.loaded = null;
        this.destroyed = false;
        created.push(this);
      }
      loadFile(path) { this.loaded = path; queueMicrotask(() => this.webContents.emit("did-finish-load")); }
      close() { if (!this.destroyed) { this.destroyed = true; this.emit("closed"); } }
      isDestroyed() { return this.destroyed; }
    }
    return { FakeWindow, created };
  }

  test("requestDecision opens one window per traceId and sends the proposal once loaded", async () => {
    const { FakeWindow, created } = fakeWindowFactory();
    const controller = new HitlPopupController({
      BrowserWindow: FakeWindow,
      htmlPath: "/fake/hitl-popup.html",
      preloadPath: "/fake/hitl-popup-preload.cjs",
      iconPath: "/fake/icon.png",
      logger: { info() {}, warn() {} },
    });
    controller.requestDecision("trace-1", { command: "ls -la", cwd: "/workspace", reason: "List files" });
    assert.equal(created.length, 1);
    assert.equal(created[0].loaded, "/fake/hitl-popup.html");
    await new Promise(resolve => queueMicrotask(resolve));
    assert.deepEqual(created[0].sent, [["hitl-popup:proposal", { command: "ls -la", cwd: "/workspace", reason: "List files" }]]);
    // A second call for the same traceId must not open a second window.
    controller.requestDecision("trace-1", { command: "ls -la", cwd: "/workspace", reason: "List files" });
    assert.equal(created.length, 1);
  });

  test("waitForDecision resolves 'pending' on timeout, then the real decision once answered", async () => {
    const { FakeWindow, created } = fakeWindowFactory();
    const controller = new HitlPopupController({
      BrowserWindow: FakeWindow,
      htmlPath: "/fake/hitl-popup.html",
      preloadPath: "/fake/hitl-popup-preload.cjs",
      iconPath: "/fake/icon.png",
      logger: { info() {}, warn() {} },
    });
    controller.requestDecision("trace-1", { command: "ls -la", cwd: "/workspace" });
    const pending = await controller.waitForDecision("trace-1", 20);
    assert.deepEqual(pending, { status: "pending" });

    const waiting = controller.waitForDecision("trace-1", 5_000);
    controller.respond("trace-1", { action: "run", command: "ls -la --edited" });
    assert.deepEqual(await waiting, { status: "decided", decision: { action: "run", command: "ls -la --edited" } });
    assert.equal(created[0].destroyed, true);
  });

  test("closing the popup without a decision resolves it as reject", async () => {
    const { FakeWindow, created } = fakeWindowFactory();
    const controller = new HitlPopupController({
      BrowserWindow: FakeWindow,
      htmlPath: "/fake/hitl-popup.html",
      preloadPath: "/fake/hitl-popup-preload.cjs",
      iconPath: "/fake/icon.png",
      logger: { info() {}, warn() {} },
    });
    controller.requestDecision("trace-1", { command: "ls -la", cwd: "/workspace" });
    const waiting = controller.waitForDecision("trace-1", 5_000);
    created[0].close();
    assert.deepEqual(await waiting, { status: "decided", decision: { action: "reject" } });
  });

  test("cancel closes a still-open popup and is a no-op once already resolved", async () => {
    const { FakeWindow, created } = fakeWindowFactory();
    const controller = new HitlPopupController({
      BrowserWindow: FakeWindow,
      htmlPath: "/fake/hitl-popup.html",
      preloadPath: "/fake/hitl-popup-preload.cjs",
      iconPath: "/fake/icon.png",
      logger: { info() {}, warn() {} },
    });
    controller.requestDecision("trace-1", { command: "ls -la", cwd: "/workspace" });
    controller.cancel("trace-1");
    assert.equal(created[0].destroyed, true);
    assert.doesNotThrow(() => controller.cancel("trace-1"));
    assert.doesNotThrow(() => controller.cancel("never-opened"));
  });
  ```

  Run: `cd launcher && bun test tests/hitl-popup.test.cjs`
  Expected: FAIL — `launcher/electron/hitl-popup.cjs` does not exist yet.

- [ ] **Step 2: Implement the controller**

  Create `launcher/electron/hitl-popup.cjs`:

  ```js
  class HitlPopupController {
    constructor({ BrowserWindow, htmlPath, preloadPath, iconPath, logger }) {
      this.BrowserWindow = BrowserWindow;
      this.htmlPath = htmlPath;
      this.preloadPath = preloadPath;
      this.iconPath = iconPath;
      this.logger = logger;
      this.pending = new Map(); // traceId -> { window, resolve, promise, decided }
    }

    requestDecision(traceId, proposal) {
      if (this.pending.has(traceId)) return;
      const window = new this.BrowserWindow({
        width: 420,
        height: 260,
        alwaysOnTop: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        icon: this.iconPath,
        title: "Codex Web GPT: approval needed",
        webPreferences: {
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      let resolve;
      const promise = new Promise((r) => { resolve = r; });
      const entry = { window, resolve, promise, decided: false };
      this.pending.set(traceId, entry);
      window.webContents.once("did-finish-load", () => {
        window.webContents.send("hitl-popup:proposal", proposal);
      });
      window.once("closed", () => this.settle(traceId, { action: "reject" }));
      window.loadFile(this.htmlPath);
    }

    respond(traceId, decision) {
      this.settle(traceId, decision);
    }

    settle(traceId, decision) {
      const entry = this.pending.get(traceId);
      if (!entry || entry.decided) return;
      entry.decided = true;
      entry.resolve(decision);
      if (!entry.window.isDestroyed()) entry.window.close();
    }

    cancel(traceId) {
      const entry = this.pending.get(traceId);
      if (!entry) return;
      if (!entry.decided && !entry.window.isDestroyed()) entry.window.close();
    }

    async waitForDecision(traceId, timeoutMs) {
      const entry = this.pending.get(traceId);
      if (!entry) return { status: "pending" };
      const decision = await Promise.race([
        entry.promise.then((value) => ({ status: "decided", decision: value })),
        new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), timeoutMs)),
      ]);
      if (decision.status === "decided") this.pending.delete(traceId);
      return decision;
    }
  }

  module.exports = { HitlPopupController };
  ```

  Run: `cd launcher && bun test tests/hitl-popup.test.cjs`
  Expected: PASS.

- [ ] **Step 3: Write the popup HTML and preload**

  Create `launcher/electron/hitl-popup-preload.cjs`:

  ```js
  const { contextBridge, ipcRenderer } = require("electron");

  contextBridge.exposeInMainWorld("hitlPopup", {
    onProposal: (callback) => {
      ipcRenderer.on("hitl-popup:proposal", (_event, proposal) => callback(proposal));
    },
    respond: (decision) => ipcRenderer.send("hitl-popup:respond", decision),
  });
  ```

  Create `launcher/electron/hitl-popup.html`:

  ```html
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'">
    <title>Approval needed</title>
    <style>
      body { font: 13px -apple-system, "Segoe UI", sans-serif; margin: 16px; color: #1a1a1a; }
      dt { font-weight: 600; margin-top: 8px; }
      dd { margin: 2px 0 0; word-break: break-word; }
      input { width: 100%; box-sizing: border-box; font: inherit; padding: 4px; margin-top: 4px; }
      .buttons { margin-top: 16px; display: flex; gap: 8px; justify-content: flex-end; }
      button { font: inherit; padding: 6px 14px; }
    </style>
  </head>
  <body>
    <dl>
      <dt>Reason</dt><dd id="reason"></dd>
      <dt>Directory</dt><dd id="cwd"></dd>
      <dt>Command</dt><dd><input id="command" type="text"></dd>
    </dl>
    <div class="buttons">
      <button id="reject">Reject</button>
      <button id="run" autofocus>Run</button>
    </div>
    <script src="./hitl-popup.js"></script>
  </body>
  </html>
  ```

  Create `launcher/electron/hitl-popup.js` (referenced above; a separate file, not inline, so the page's CSP can omit `'unsafe-inline'` from `script-src`):

  ```js
  window.hitlPopup.onProposal((proposal) => {
    document.getElementById("reason").textContent = proposal.reason || "(none given)";
    document.getElementById("cwd").textContent = proposal.cwd;
    document.getElementById("command").value = proposal.command;
  });
  document.getElementById("run").addEventListener("click", () => {
    window.hitlPopup.respond({ action: "run", command: document.getElementById("command").value });
  });
  document.getElementById("reject").addEventListener("click", () => {
    window.hitlPopup.respond({ action: "reject" });
  });
  ```

  No automated test for these two files (a DOM/Electron renderer smoke test is out of scope for this plan); they are exercised by the manual smoke test in Task 6.

- [ ] **Step 4: Commit**

  ```bash
  git add launcher/electron/hitl-popup.cjs launcher/electron/hitl-popup.html launcher/electron/hitl-popup.js launcher/electron/hitl-popup-preload.cjs launcher/tests/hitl-popup.test.cjs
  git commit -m "feat: add the main-process HITL approval popup controller"
  ```

---

### Task 4: Control-server endpoints

**Files:**
- Modify: `launcher/electron/control-server.cjs`
- Modify: `launcher/tests/control-server.test.cjs`

**Interfaces:**
- Consumes: a `hitlApproval` constructor dependency shaped `{ requestDecision(traceId, proposal), waitForDecision(traceId, timeoutMs), cancel(traceId) }` (Task 3's `HitlPopupController` satisfies this; tests here pass a stub).
- Removes: the `notifyHitlApprovalPending` constructor dependency and the `/v1/notify/hitl-pending` route entirely.

- [ ] **Step 1: Write the failing tests**

  In `launcher/tests/control-server.test.cjs`, replace the two tests named `"browser control server dispatches a HITL notification without touching the browser host"` and `"browser control server survives a throwing HITL notification callback"` with:

  ```js
  const HITL_DECIDE_OBSERVER_TIMEOUT_MS = 30;

  test("browser control server relays a HITL decision through a bounded long poll", async () => {
    const calls = [];
    const hitlApproval = {
      requestDecision: (traceId, proposal) => calls.push(["requestDecision", traceId, proposal]),
      waitForDecision: async (traceId) => calls.push(["waitForDecision", traceId]) && { status: "pending" },
      cancel: (traceId) => calls.push(["cancel", traceId]),
    };
    const server = await new BrowserControlServer({
      logger: { info() {}, warn() {} },
      getBrowserHost: () => assert.fail("HITL decide must not need the browser host"),
      getPreferences: () => ({}),
      hitlApproval,
      hitlDecideObserverTimeoutMs: HITL_DECIDE_OBSERVER_TIMEOUT_MS,
    }).start();
    const descriptor = server.descriptor();
    try {
      const unauthenticated = await fetch(`${descriptor.endpoint}/v1/hitl/decide`, { method: "POST" });
      assert.equal(unauthenticated.status, 401);

      const post = () => fetch(`${descriptor.endpoint}/v1/hitl/decide`, {
        method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "abcdef123456", command: "ls -la", cwd: "/workspace", reason: "List files" }),
      });
      const first = await post();
      assert.equal(first.status, 202);
      assert.deepEqual(await first.json(), { status: "pending" });
      assert.deepEqual(calls[0], ["requestDecision", "abcdef123456", { command: "ls -la", cwd: "/workspace", reason: "List files" }]);

      hitlApproval.waitForDecision = async () => ({ status: "decided", decision: { action: "run", command: "ls -la --edited" } });
      const second = await post();
      assert.equal(second.status, 200);
      assert.deepEqual(await second.json(), { ok: true, action: "run", command: "ls -la --edited" });

      const cancelResponse = await fetch(`${descriptor.endpoint}/v1/hitl/decide/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "abcdef123456" }),
      });
      assert.equal(cancelResponse.status, 200);
      assert.deepEqual(await cancelResponse.json(), { ok: true });
      assert.deepEqual(calls.at(-1), ["cancel", "abcdef123456"]);
    } finally {
      await server.close();
    }
  });

  test("browser control server rejects a malformed HITL decide request", async () => {
    const hitlApproval = {
      requestDecision: () => assert.fail("must not request a decision for an invalid body"),
      waitForDecision: async () => ({ status: "pending" }),
      cancel: () => {},
    };
    const server = await new BrowserControlServer({
      logger: { info() {}, warn() {} },
      getBrowserHost: () => assert.fail("HITL decide must not need the browser host"),
      getPreferences: () => ({}),
      hitlApproval,
    }).start();
    const descriptor = server.descriptor();
    const post = (body) => fetch(`${descriptor.endpoint}/v1/hitl/decide`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      assert.equal((await post({ command: "ls -la", cwd: "/workspace" })).status, 400);
      assert.equal((await post({ traceId: "abcdef123456", cwd: "/workspace" })).status, 400);
      assert.equal((await post({ traceId: "abcdef123456", command: "ls -la" })).status, 400);
    } finally {
      await server.close();
    }
  });
  ```

  Run: `cd launcher && bun test tests/control-server.test.cjs`
  Expected: FAIL — the old `/v1/notify/hitl-pending` route still exists and `/v1/hitl/decide` doesn't.

- [ ] **Step 2: Replace the endpoint and constructor dependency**

  In `launcher/electron/control-server.cjs`, replace the constructor:

  ```js
  constructor({ logger, getBrowserHost, getPreferences, notifyHitlApprovalPending }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.notifyHitlApprovalPending = notifyHitlApprovalPending || (() => {});
  ```

  with:

  ```js
  constructor({ logger, getBrowserHost, getPreferences, hitlApproval, hitlDecideObserverTimeoutMs = 30_000 }) {
    this.logger = logger;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.hitlApproval = hitlApproval;
    this.hitlDecideObserverTimeoutMs = hitlDecideObserverTimeoutMs;
  ```

  Replace the `/v1/notify/hitl-pending` block with:

  ```js
  if (request.url === "/v1/hitl/decide" || request.url === "/v1/hitl/decide/cancel") {
    if (request.method !== "POST") {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      const body = await readJson(request, MAX_BODY_BYTES);
      if (!body || typeof body !== "object" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.traceId || "")) {
        throw new Error("traceId is invalid");
      }
      if (request.url === "/v1/hitl/decide/cancel") {
        this.hitlApproval.cancel(body.traceId);
        writeJson(response, 200, { ok: true });
        return;
      }
      if (typeof body.command !== "string" || !body.command) throw new Error("command is invalid");
      if (typeof body.cwd !== "string" || !body.cwd) throw new Error("cwd is invalid");
      if (body.reason !== undefined && typeof body.reason !== "string") throw new Error("reason is invalid");
      this.hitlApproval.requestDecision(body.traceId, { command: body.command, cwd: body.cwd, reason: body.reason });
      const outcome = await this.hitlApproval.waitForDecision(body.traceId, this.hitlDecideObserverTimeoutMs);
      if (outcome.status === "pending") {
        writeJson(response, 202, { status: "pending" });
        return;
      }
      writeJson(response, 200, { ok: true, ...outcome.decision });
      return;
    } catch (error) {
      writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  ```

  Run: `cd launcher && bun test tests/control-server.test.cjs`
  Expected: PASS.

- [ ] **Step 3: Commit**

  ```bash
  git add launcher/electron/control-server.cjs launcher/tests/control-server.test.cjs
  git commit -m "feat: replace the HITL notify endpoint with a decision long-poll"
  ```

---

### Task 4.5 note for the implementer

The request-close-cancels-the-popup behavior described in the spec (client disconnect during the long poll closes the popup) is a nice-to-have the bounded-timeout design above does not strictly need: because the server's wait is already bounded (`hitlDecideObserverTimeoutMs`) and the client always follows up with an explicit `/v1/hitl/decide/cancel` in the racing wrapper's `finally` block (Task 2), an abandoned popup is closed within one request/timeout cycle either way. Do not add `request.on("close", ...)` handling for this endpoint — it is redundant with the explicit cancel call and would add complexity for no behavioral gain.

---

### Task 5: Wire the popup controller into main.cjs

**Files:**
- Modify: `launcher/electron/main.cjs`

**Interfaces:**
- Consumes: `HitlPopupController` (Task 3), the extended `BrowserControlServer` constructor (Task 4).

- [ ] **Step 1: Remove the superseded notification function and its import**

  Remove the `notifyHitlApprovalPending` function (added by the earlier plain-notification change, including its diagnostic `logger.info("browser.hitl_notification_dispatched", ...)` line) from `launcher/electron/main.cjs`. Remove `Notification` from the `require("electron")` destructure if nothing else in this file uses it (check first — `grep -n "Notification" launcher/electron/main.cjs` after removing the function; if only the destructure import remains, delete it too).

- [ ] **Step 2: Construct the popup controller and wire it into the control server**

  Add near the top of the file, alongside the other `require`s:

  ```js
  const { HitlPopupController } = require("./hitl-popup.cjs");
  ```

  Find where `browserControl = await new BrowserControlServer({...}).start();` is constructed (it currently passes `notifyHitlApprovalPending: () => notifyHitlApprovalPending(logger)`). Replace that line with:

  ```js
  const hitlPopup = new HitlPopupController({
    BrowserWindow,
    htmlPath: path.join(__dirname, "hitl-popup.html"),
    preloadPath: path.join(__dirname, "hitl-popup-preload.cjs"),
    iconPath: APP_ICON_PATH,
    logger,
  });
  ```

  placed just before the `browserControl = await new BrowserControlServer({...})` call, and change that call's options object to pass `hitlApproval: hitlPopup` instead of `notifyHitlApprovalPending: ...`.

  Wire the renderer's decision back to the controller — add near the other `ipcMain.on`/`ipcMain.handle` registrations in this file:

  ```js
  ipcMain.on("hitl-popup:respond", (event, decision) => {
    const traceId = [...hitlPopup.pending.entries()]
      .find(([, entry]) => entry.window.webContents === event.sender)?.[0];
    if (traceId) hitlPopup.respond(traceId, decision);
  });
  ```

  Run: `cd launcher && bun run typecheck`
  Expected: clean.

- [ ] **Step 2: Verify no test regressions**

  Run: `cd launcher && bun test`
  Expected: all pass (no test file exercises `main.cjs` directly, per the codebase's existing convention — this step confirms nothing else broke).

- [ ] **Step 3: Commit**

  ```bash
  git add launcher/electron/main.cjs
  git commit -m "feat: open the HITL approval popup from the launcher's main process"
  ```

---

### Task 6: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck both projects**

  Run: `bun run typecheck` (repo root) and `cd launcher && bun run typecheck`
  Expected: both clean.

- [ ] **Step 2: Run both full test suites**

  Run: `bun test` (repo root) and `cd launcher && bun test`
  Expected: all pass (the pre-existing `tests/prompt-contract.test.ts` "Bigger Context compaction..." timeout flake, if it recurs, is a known unrelated issue — rerun that one test alone to confirm before treating it as a regression).

- [ ] **Step 3: Manual smoke test (documented, not automated)**

  With `codex-chatgpt-web serve --hitl` running in a real terminal and the desktop launcher open (launcher detecting the daemon as `external`, per the existing coexistence behavior):
  1. Trigger a turn that emits `[EXEC_REQUEST]` (e.g. ask Codex to list a directory).
  2. Confirm the popup window opens with the reason/directory/command populated.
  3. Edit the command field and click Run; confirm the *edited* command is what actually executes (check the tool's output / the terminal, which should show its own prompt was cancelled).
  4. On a second trigger, answer in the terminal instead; confirm the popup window closes on its own.
  5. On a third trigger, close the popup via its window-close button without clicking anything; confirm the command is rejected (not run).

  Report the outcome in the session, not as a new automated test.
