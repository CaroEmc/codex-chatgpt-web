const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const HITL_TERMINAL_TITLE = "codex-chatgpt-web HITL";

// Every value lands inside a double-quoted token of a .cmd script, where `"` ends the token,
// `%` expands variables, and a line break starts a new command. Refuse rather than escape.
function assertBatchSafe(value, label) {
  if (typeof value !== "string" || !value || /["%\r\n\0]/.test(value)) {
    throw new Error(`${label} contains characters that cannot be passed to a Windows terminal safely`);
  }
  return value;
}

function validateHitlWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Choose a HITL workspace folder first");
  const resolved = path.resolve(value.trim());
  assertBatchSafe(resolved, "HITL workspace folder");
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`HITL workspace folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`HITL workspace is not a folder: ${resolved}`);
  return resolved;
}

/** `invocation` is a runtime-command.cjs invocation whose args already end in the serve arguments. */
function hitlTerminalScript(invocation) {
  const quoted = [invocation.executable, ...invocation.args]
    .map((part, index) => `"${assertBatchSafe(part, index === 0 ? "Runtime executable" : "Runtime argument")}"`)
    .join(" ");
  return [
    "@echo off",
    "chcp 65001 >nul",
    `title ${HITL_TERMINAL_TITLE}`,
    `cd /d "${assertBatchSafe(invocation.cwd, "Runtime directory")}"`,
    quoted,
    "echo.",
    "echo [codex-chatgpt-web] HITL server exited with code %ERRORLEVEL%.",
    "pause",
    "",
  ].join("\r\n");
}

/** Opens a new console window so the daemon gets a real TTY: HITL refuses to activate without one,
 * and the operator can approve from that terminal as well as from the launcher popup. */
function launchHitlTerminal({
  invocation,
  scriptPath,
  environment,
  platform = process.platform,
  spawnProcess = spawn,
  writeFile = writePrivateFileAtomic,
}) {
  if (platform !== "win32") throw new Error("Starting HITL from the launcher is currently supported on Windows only");
  assertBatchSafe(scriptPath, "HITL script path");
  writeFile(scriptPath, hitlTerminalScript(invocation));
  const child = spawnProcess(
    "cmd.exe",
    ["/d", "/c", "start", `"${HITL_TERMINAL_TITLE}"`, "cmd.exe", "/d", "/c", `"${scriptPath}"`],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
      windowsHide: false,
      windowsVerbatimArguments: true,
    },
  );
  child.unref?.();
  return child;
}

/** The command a user pastes into their own terminal; the CLI wrapper name matches the installers. */
function hitlCommandLine(workspace, autoApprove) {
  const folder = typeof workspace === "string" ? workspace.trim() : "";
  const quoted = !folder ? "<project folder>" : /[\s&()^]/.test(folder) ? `"${folder}"` : folder;
  return `codex-chatgpt-web serve --hitl --workspace ${quoted}${autoApprove ? " --hitl-auto-approve" : ""}`;
}

module.exports = {
  HITL_TERMINAL_TITLE,
  hitlCommandLine,
  hitlTerminalScript,
  launchHitlTerminal,
  validateHitlWorkspace,
};
