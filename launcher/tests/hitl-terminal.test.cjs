const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  HITL_TERMINAL_TITLE,
  hitlTerminalScript,
  launchHitlTerminal,
  validateHitlWorkspace,
} = require("../electron/hitl-terminal.cjs");

const invocation = {
  executable: "C:\\Program Files\\Bun\\bun.exe",
  args: ["C:\\runtime\\app\\cli.js", "serve", "--hitl", "--workspace", "D:\\work\\lib bff"],
  cwd: "C:\\runtime",
};

test("validateHitlWorkspace resolves an existing folder and rejects missing or unsafe ones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hitl-terminal-"));
  try {
    assert.equal(validateHitlWorkspace(root), path.resolve(root));
    assert.throws(() => validateHitlWorkspace(null), /Choose a HITL workspace folder/);
    assert.throws(() => validateHitlWorkspace(path.join(root, "missing")), /does not exist/);
    const file = path.join(root, "file.txt");
    fs.writeFileSync(file, "x");
    assert.throws(() => validateHitlWorkspace(file), /not a folder/);
    assert.throws(() => validateHitlWorkspace(path.join(root, "100%")), /cannot be passed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hitlTerminalScript quotes every part, keeps the window open on exit, and uses CRLF", () => {
  const script = hitlTerminalScript(invocation);
  assert.match(script, /\r\n/);
  assert.ok(script.includes('cd /d "C:\\runtime"'));
  assert.ok(script.includes(
    '"C:\\Program Files\\Bun\\bun.exe" "C:\\runtime\\app\\cli.js" "serve" "--hitl" "--workspace" "D:\\work\\lib bff"',
  ));
  assert.ok(script.includes(`title ${HITL_TERMINAL_TITLE}`));
  assert.ok(script.trimEnd().endsWith("pause"));
});

test("hitlTerminalScript refuses arguments that would break out of batch quoting", () => {
  for (const bad of ['a"b', "a%PATH%b", "a\r\nb"]) {
    assert.throws(
      () => hitlTerminalScript({ ...invocation, args: ["serve", "--workspace", bad] }),
      /cannot be passed/,
    );
  }
});

test("launchHitlTerminal writes the script and opens it in a detached visible console", () => {
  const writes = [];
  const spawns = [];
  let unrefCalled = false;
  launchHitlTerminal({
    invocation,
    scriptPath: "C:\\home\\runtime\\hitl-terminal.cmd",
    environment: { A: "1" },
    platform: "win32",
    writeFile: (file, content) => writes.push({ file, content }),
    spawnProcess: (command, args, options) => {
      spawns.push({ command, args, options });
      return { unref: () => { unrefCalled = true; } };
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].file, "C:\\home\\runtime\\hitl-terminal.cmd");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, "cmd.exe");
  assert.deepEqual(spawns[0].args.slice(0, 3), ["/d", "/c", "start"]);
  assert.equal(spawns[0].args.at(-1), '"C:\\home\\runtime\\hitl-terminal.cmd"');
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.windowsHide, false);
  assert.equal(spawns[0].options.windowsVerbatimArguments, true);
  assert.deepEqual(spawns[0].options.env, { A: "1" });
  assert.equal(unrefCalled, true);
});

test("launchHitlTerminal is Windows-only", () => {
  assert.throws(() => launchHitlTerminal({
    invocation,
    scriptPath: "/tmp/hitl.cmd",
    environment: {},
    platform: "darwin",
    writeFile: () => assert.fail("must not write"),
    spawnProcess: () => assert.fail("must not spawn"),
  }), /Windows only/);
});

test("hitlCommandLine builds the paste-ready serve command, quoting folders that need it", () => {
  const { hitlCommandLine } = require("../electron/hitl-terminal.cjs");
  assert.equal(
    hitlCommandLine("D:/work/proj", true),
    "codex-chatgpt-web serve --hitl --workspace D:/work/proj --hitl-auto-approve",
  );
  assert.equal(
    hitlCommandLine("D:/my work/a&b", false),
    "codex-chatgpt-web serve --hitl --workspace \"D:/my work/a&b\"",
  );
  assert.equal(
    hitlCommandLine(null, true),
    "codex-chatgpt-web serve --hitl --workspace <project folder> --hitl-auto-approve",
  );
});
