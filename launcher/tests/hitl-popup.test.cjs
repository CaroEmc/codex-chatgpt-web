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
