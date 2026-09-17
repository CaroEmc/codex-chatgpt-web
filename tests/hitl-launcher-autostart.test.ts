import { expect, test } from "bun:test";
import { ensureLauncherBrowserHost, type LauncherAutostartDeps } from "../src/hitl/launcher-autostart";
import type { LauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

function descriptor(profile: "production" | "development"): LauncherBrowserHostDescriptor {
  return { profile } as LauncherBrowserHostDescriptor;
}

function fakeDeps(readResults: Array<LauncherBrowserHostDescriptor | Error>) {
  let clock = 0;
  const started: string[] = [];
  const deps: LauncherAutostartDeps = {
    readDescriptor: () => {
      const next = readResults.length > 1 ? readResults.shift()! : readResults[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    findExecutable: () => "C:\\Launcher\\Codex Web GPT.exe",
    startLauncher: executable => { started.push(executable); },
    sleep: async ms => { clock += ms; },
    now: () => clock,
  };
  return { deps, started };
}

test("a running production launcher is left alone", async () => {
  const { deps, started } = fakeDeps([descriptor("production")]);
  expect(await ensureLauncherBrowserHost("d.json", {}, deps)).toBe("running");
  expect(started).toEqual([]);
});

test("a missing launcher is started and awaited until its descriptor is valid", async () => {
  const missing = new Error("descriptor is missing");
  const { deps, started } = fakeDeps([missing, missing, missing, descriptor("production")]);
  expect(await ensureLauncherBrowserHost("d.json", {}, deps)).toBe("started");
  expect(started).toEqual(["C:\\Launcher\\Codex Web GPT.exe"]);
});

test("a DEV launcher descriptor does not count as the production browser host", async () => {
  const { deps, started } = fakeDeps([descriptor("development")]);
  await expect(ensureLauncherBrowserHost("d.json", { timeoutMs: 1_000 }, deps)).rejects.toThrow(
    /did not become ready within 1000ms: .*development/,
  );
  expect(started).toHaveLength(1);
});

test("a launcher that never becomes ready times out with the last error", async () => {
  const { deps } = fakeDeps([new Error("process is not running")]);
  await expect(ensureLauncherBrowserHost("d.json", { timeoutMs: 500 }, deps)).rejects.toThrow(
    /did not become ready within 500ms: process is not running/,
  );
});

test("a missing launcher executable surfaces the lookup error without waiting", async () => {
  const { deps } = fakeDeps([new Error("missing")]);
  deps.findExecutable = () => { throw new Error("Installed Codex Web GPT launcher was not found"); };
  await expect(ensureLauncherBrowserHost("d.json", {}, deps)).rejects.toThrow(/was not found/);
});
