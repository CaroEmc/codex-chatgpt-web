import { spawn } from "node:child_process";

/** Both the machine-wide and per-user Root stores are read, since a corporate SSL-inspection root
 * CA can land in either depending on how IT deployed it (Group Policy vs. a per-user install). */
const POWERSHELL_SCRIPT = "Get-ChildItem Cert:\\LocalMachine\\Root,Cert:\\CurrentUser\\Root "
  + "-ErrorAction SilentlyContinue | ForEach-Object { "
  + "'-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData,'InsertLineBreaks'); "
  + "'-----END CERTIFICATE-----' }";

const POWERSHELL_TIMEOUT_MS = 5_000;

export interface RunPowerShellResult {
  code: number;
  stdout: string;
}

export type RunPowerShell = (script: string) => Promise<RunPowerShellResult>;

function spawnPowerShell(script: string): Promise<RunPowerShellResult> {
  return new Promise(resolvePromise => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => resolvePromise({ code: 1, stdout: "" }));
    child.on("close", code => resolvePromise({ code: code ?? 1, stdout }));
  });
}

/** Reads the Windows OS certificate store so Bun's fetch can trust it alongside its own bundled CA
 * list -- the same trust a corporate SSL-inspection proxy's re-signed certificates already get from
 * Chromium (browser-only mode) and from every other app on the machine. A no-op on other platforms.
 * Fails open on any error: this must never turn a request that would have succeeded before this
 * existed into a failure. */
export async function windowsExtraTrustedCa(
  platform: NodeJS.Platform = process.platform,
  runPowerShell: RunPowerShell = spawnPowerShell,
): Promise<string | undefined> {
  if (platform !== "win32") return undefined;
  try {
    const { code, stdout } = await runPowerShell(POWERSHELL_SCRIPT);
    const trimmed = stdout.trim();
    if (code !== 0 || !trimmed.includes("BEGIN CERTIFICATE")) {
      console.warn(`[native-tls-windows] windows_ca_store_read_failed ${JSON.stringify({ code })}`);
      return undefined;
    }
    return trimmed;
  } catch (error) {
    console.warn(`[native-tls-windows] windows_ca_store_read_failed ${JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
    })}`);
    return undefined;
  }
}
