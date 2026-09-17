const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { diffFileSnapshots, snapshotFiles, watchedSetupFiles } = require("../electron/setup-file-changes.cjs");

test("watchedSetupFiles covers the Codex config and the runtime config", () => {
  const files = watchedSetupFiles({ coreHome: "/core", codexHome: "/codex" });
  assert.ok(files.includes(path.join("/codex", "config.toml")));
  assert.ok(files.includes(path.join("/core", "config.json")));
  assert.ok(files.includes(path.join("/core", "codex", "integration-journal.json")));
});

test("diffFileSnapshots reports created, modified, and removed files only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-file-changes-"));
  try {
    const kept = path.join(root, "kept.txt");
    const edited = path.join(root, "edited.txt");
    const created = path.join(root, "created.txt");
    const removed = path.join(root, "removed.txt");
    fs.writeFileSync(kept, "same");
    fs.writeFileSync(edited, "before");
    fs.writeFileSync(removed, "gone soon");
    const files = [kept, edited, created, removed];
    const before = snapshotFiles(files);
    fs.writeFileSync(edited, "after");
    fs.writeFileSync(created, "new");
    fs.rmSync(removed);
    const changes = diffFileSnapshots(before, snapshotFiles(files));
    assert.deepEqual(changes, [
      { path: edited, change: "modified" },
      { path: created, change: "created" },
      { path: removed, change: "deleted" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
