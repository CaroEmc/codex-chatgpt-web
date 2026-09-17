import { spawn } from "node:child_process";
import { findInstalledLauncherExecutable } from "../dev-chat/profile";
import { readLauncherBrowserHostDescriptor, type LauncherBrowserHostDescriptor } from "../launcher-browser-host";

export interface LauncherAutostartDeps {
  readDescriptor: (path: string) => LauncherBrowserHostDescriptor;
  findExecutable: () => string;
  startLauncher: (executable: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultDeps: LauncherAutostartDeps = {
  readDescriptor: readLauncherBrowserHostDescriptor,
  findExecutable: () => findInstalledLauncherExecutable(),
  startLauncher: executable => {
    // Inherited from Electron hosts (e.g. a VS Code terminal or extension); it would make the
    // launcher run as plain Node and exit immediately.
    const { ELECTRON_RUN_AS_NODE: _electronAsNode, ...env } = process.env;
    const child = spawn(executable, [], { detached: true, env, stdio: "ignore", windowsHide: false });
    child.unref();
  },
  sleep: ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

function productionDescriptor(deps: LauncherAutostartDeps, path: string): LauncherBrowserHostDescriptor {
  const descriptor = deps.readDescriptor(path);
  if (descriptor.profile !== "production") {
    throw new Error(`Launcher descriptor belongs to ${descriptor.profile}, not the production launcher`);
  }
  return descriptor;
}

/**
 * A foreground `serve --hitl` owns the Responses port, so nothing else starts the launcher that
 * hosts its ChatGPT browser. Without it every turn fails before reaching ChatGPT, which Codex shows
 * as "Selected model is at capacity". Call this only after the server has bound its port, so a
 * launcher that still tries to supervise its own daemon finds the port taken instead of racing it.
 */
export async function ensureLauncherBrowserHost(
  descriptorPath: string,
  options: { timeoutMs?: number } = {},
  deps: LauncherAutostartDeps = defaultDeps,
): Promise<"running" | "started"> {
  try {
    productionDescriptor(deps, descriptorPath);
    return "running";
  } catch {
    // Absent or stale: start the launcher, which rewrites its own descriptor once ready.
  }
  deps.startLauncher(deps.findExecutable());
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = deps.now() + timeoutMs;
  let lastError = "descriptor is not ready";
  while (deps.now() < deadline) {
    await deps.sleep(250);
    try {
      productionDescriptor(deps, descriptorPath);
      return "started";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Launcher did not become ready within ${timeoutMs}ms: ${lastError}`);
}
