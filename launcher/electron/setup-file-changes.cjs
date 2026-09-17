const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** Files a core setup can create, rewrite, or remove; reported back so users see what changed. */
function watchedSetupFiles({ coreHome, codexHome }) {
  return [
    path.join(codexHome, "config.toml"),
    path.join(codexHome, "models_cache.json"),
    path.join(coreHome, "config.json"),
    path.join(coreHome, "codex", "integration-journal.json"),
    path.join(coreHome, "codex", "integration-journal.recovery.json"),
  ];
}

function snapshotFiles(paths, readFile = fs.readFileSync) {
  const snapshot = new Map();
  for (const file of paths) {
    try {
      snapshot.set(file, crypto.createHash("sha256").update(readFile(file)).digest("hex"));
    } catch {
      snapshot.set(file, null);
    }
  }
  return snapshot;
}

function diffFileSnapshots(before, after) {
  const changes = [];
  for (const [file, previous] of before) {
    const current = after.has(file) ? after.get(file) : null;
    if (previous === current) continue;
    const change = previous === null ? "created" : current === null ? "deleted" : "modified";
    changes.push({ path: file, change });
  }
  return changes;
}

module.exports = {
  diffFileSnapshots,
  snapshotFiles,
  watchedSetupFiles,
};
