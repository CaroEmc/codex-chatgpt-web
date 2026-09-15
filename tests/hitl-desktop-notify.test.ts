import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDesktopNotify } from "../src/adapters/chatgpt-web/hitl-desktop-notify";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import type { ApprovalDecision, ApprovalGateway, ExecProposal } from "../src/hitl/approval";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(controlEndpoint: string): string {
  const root = mkdtempSync(join(tmpdir(), "codex-hitl-notify-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 3,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    control: { endpoint: controlEndpoint, token: "launcher-control-token-0123456789abcdefghijklmnop" },
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    surfaceTargets: { ["launcher_surface_id_0123456789AB"]: "native-owned-target" },
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

const proposal: ExecProposal = { command: "ls -la", cwd: "/workspace", reason: "List files" };

test("withDesktopNotify fires the launcher notification and still delegates to the wrapped gateway", async () => {
  let notifyRequests = 0;
  const server = createServer((request, response) => {
    notifyRequests += 1;
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
    const decision: ApprovalDecision = { action: "run", command: "ls -la" };
    let requested: ExecProposal | undefined;
    const inner: ApprovalGateway = {
      request: async proposal => {
        requested = proposal;
        return decision;
      },
    };
    const wrapped = withDesktopNotify(inner, path);
    await expect(wrapped.request(proposal)).resolves.toEqual(decision);
    expect(requested).toEqual(proposal);
    // The notification fires without being awaited by request(); give it a tick to land.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(notifyRequests).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("withDesktopNotify never blocks or fails the prompt when the launcher is unreachable", async () => {
  const path = descriptorFile("http://127.0.0.1:1");
  const decision: ApprovalDecision = { action: "reject" };
  const inner: ApprovalGateway = { request: async () => decision };
  const wrapped = withDesktopNotify(inner, path);
  await expect(wrapped.request(proposal)).resolves.toEqual(decision);
});
