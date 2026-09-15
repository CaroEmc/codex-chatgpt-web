class HitlPopupController {
  constructor({ BrowserWindow, htmlPath, preloadPath, iconPath, logger }) {
    this.BrowserWindow = BrowserWindow;
    this.htmlPath = htmlPath;
    this.preloadPath = preloadPath;
    this.iconPath = iconPath;
    this.logger = logger;
    this.pending = new Map(); // requestId -> { window, resolve, promise, decided }
  }

  requestDecision(requestId, proposal) {
    if (this.pending.has(requestId)) return;
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
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.setMenu(null);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { window, resolve, promise, decided: false };
    this.pending.set(requestId, entry);
    window.webContents.once("did-finish-load", () => {
      window.webContents.send("hitl-popup:proposal", proposal);
    });
    window.once("closed", () => this.settle(requestId, { action: "reject" }));
    window.loadFile(this.htmlPath);
    this.logger.info("hitl_popup.opened", { requestId });
  }

  respond(requestId, decision) {
    this.settle(requestId, decision);
  }

  settle(requestId, decision) {
    const entry = this.pending.get(requestId);
    if (!entry || entry.decided) return;
    entry.decided = true;
    this.logger.info("hitl_popup.settled", { requestId, action: decision.action });
    entry.resolve(decision);
    this.pending.delete(requestId);
    if (!entry.window.isDestroyed()) entry.window.close();
  }

  cancel(requestId) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (!entry.decided && !entry.window.isDestroyed()) {
      this.logger.info("hitl_popup.cancelled", { requestId });
      entry.window.close();
    }
  }

  async waitForDecision(requestId, timeoutMs) {
    const entry = this.pending.get(requestId);
    if (!entry) return { status: "pending" };
    return await Promise.race([
      entry.promise.then((value) => ({ status: "decided", decision: value })),
      new Promise((resolve) => setTimeout(() => resolve({ status: "pending" }), timeoutMs)),
    ]);
  }
}

module.exports = { HitlPopupController };
