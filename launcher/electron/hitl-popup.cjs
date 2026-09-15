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
