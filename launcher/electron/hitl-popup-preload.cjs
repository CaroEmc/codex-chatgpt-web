const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hitlPopup", {
  onProposal: (callback) => {
    ipcRenderer.on("hitl-popup:proposal", (_event, proposal) => callback(proposal));
  },
  respond: (decision) => ipcRenderer.send("hitl-popup:respond", decision),
});
