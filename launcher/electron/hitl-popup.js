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
