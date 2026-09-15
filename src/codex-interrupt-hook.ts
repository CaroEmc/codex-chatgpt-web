import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import type { AppConfig } from "./config";
import { getConfigDir } from "./config";
import type { InstalledCodexInterruptHook } from "./codex-integration-shared";

export const MANAGED_INTERRUPT_HOOK_START =
  "# Managed by codex-chatgpt-web: release the exact Responses request when its Codex turn is interrupted.";
export const MANAGED_INTERRUPT_HOOK_END =
  "# End codex-chatgpt-web interrupt lifecycle hook.";

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJson(item)]),
  );
}

/** Match codex_config::version_for_toml for the normalized Interrupt command hook. */
export function codexInterruptHookHash(command: string): string {
  const identity = canonicalJson({
    event_name: "interrupt",
    hooks: [{
      type: "command",
      command,
      timeout: 3,
      async: false,
    }],
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function posixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function cmdShellArgument(value: string): string {
  if (value.includes('"') || /[\r\n]/.test(value)) {
    throw new Error("Codex interrupt hook command contains an invalid Windows path character");
  }
  // Codex executes command hooks through cmd.exe /C on Windows. Quoting every argument preserves
  // spaces and shell metacharacters in the installed runtime path.
  return `"${value}"`;
}

export function codexInterruptHookCommand(
  config: Pick<AppConfig, "runtimeCommand">,
  home = getConfigDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const absoluteHome = platform === "win32" ? win32.resolve(home) : posix.resolve(home);
  const args = [...config.runtimeCommand, "--home", absoluteHome, "hook", "interrupt"];
  return args.map(platform === "win32" ? cmdShellArgument : posixShellArgument).join(" ");
}

function lineEnding(text: string): "\n" | "\r\n" | "\r" {
  return text.includes("\r\n") ? "\r\n" : text.includes("\n") ? "\n" : text.includes("\r") ? "\r" : "\n";
}

function interruptGroupCount(text: string): number {
  return text.split(/\r\n|\n|\r/).filter(line => /^\s*\[\[hooks\.Interrupt\]\]\s*(?:#.*)?$/.test(line)).length;
}

function managedMarkerCount(text: string): number {
  return text.split(MANAGED_INTERRUPT_HOOK_START).length - 1;
}

function canonicalConfigPath(configPath: string): string {
  const absolute = resolve(configPath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function installCodexInterruptHook(
  text: string,
  configPath: string,
  config: Pick<AppConfig, "runtimeCommand">,
): { text: string; installed: InstalledCodexInterruptHook } {
  return installCodexInterruptHookCommand(text, configPath, codexInterruptHookCommand(config));
}

export function installCodexInterruptHookCommand(
  text: string,
  configPath: string,
  command: string,
): { text: string; installed: InstalledCodexInterruptHook } {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex config already contains a codex-chatgpt-web interrupt hook marker");
  }
  const groupIndex = interruptGroupCount(text);
  const stateKey = `${canonicalConfigPath(configPath)}:interrupt:${groupIndex}:0`;
  const trustedHash = codexInterruptHookHash(command);
  const ending = lineEnding(text);
  const core = [
    MANAGED_INTERRUPT_HOOK_START,
    "[[hooks.Interrupt]]",
    "",
    "[[hooks.Interrupt.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    "timeout = 3",
    "",
    `[hooks.state.${JSON.stringify(stateKey)}]`,
    `trusted_hash = ${JSON.stringify(trustedHash)}`,
    MANAGED_INTERRUPT_HOOK_END,
  ].join(ending);
  const leading = text.length === 0
    ? ""
    : text.endsWith(`${ending}${ending}`)
      ? ""
      : text.endsWith(ending)
        ? ending
        : `${ending}${ending}`;
  const trailing = text.length > 0 && text.endsWith(ending) ? ending : "";
  const fragment = `${leading}${core}${trailing}`;
  return {
    text: `${text}${fragment}`,
    installed: { command, groupIndex, stateKey, trustedHash, fragment },
  };
}

function hookTextPattern(text: string): string {
  return text.split(/\r\n|\n|\r/)
    .map(line => line.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
    .join("(?:\\r\\n|\\n|\\r)");
}

/** The hook definition and its trust-state table are always written contiguously (see
 * `installCodexInterruptHookCommand`), but Codex's own TOML editor groups every `[hooks.state.*]`
 * table together wherever it next rewrites the file, relocating ours away from the hook it
 * belongs to. Splitting them lets `locateCodexInterruptHook` verify each independently instead of
 * requiring an adjacency the underlying editor does not preserve. */
function splitInstalledFragment(installed: InstalledCodexInterruptHook): { header: string; stateBlock: string } {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  const stateIndex = ownedPrefix.indexOf("[hooks.state.");
  if (stateIndex < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  return {
    header: ownedPrefix.slice(0, stateIndex).replace(/(?:\r\n|\n|\r)+$/, ""),
    stateBlock: ownedPrefix.slice(stateIndex),
  };
}

function locateCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): Array<{
  start: number; end: number;
}> {
  const marker = installed.fragment.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (marker < 0) throw new Error("Codex interrupt lifecycle hook journal fragment is invalid");
  const ownedPrefix = installed.fragment.slice(0, marker);
  const { header, stateBlock } = splitInstalledFragment(installed);

  // The hook definition (comment through `timeout = 3`) must still appear as one contiguous,
  // unmodified block. Native config writes normalize CRLF to LF; owned fields must still match
  // exactly.
  const headerPattern = new RegExp(hookTextPattern(header), "g");
  const headerMatch = headerPattern.exec(text);
  if (!headerMatch || headerPattern.exec(text)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  const first = headerMatch.index;
  const headerEnd = first + headerMatch[0].length;
  if (interruptGroupCount(text.slice(0, first)) !== installed.groupIndex) {
    throw new Error("Codex interrupt lifecycle hook order changed after setup; refusing to overwrite it");
  }

  // The trust-state table can now live anywhere in the file. Its exact two-line text is unique to
  // this stateKey/hash pair, so requiring exactly one unambiguous match anywhere is exactly as
  // strict as requiring adjacency was.
  const statePattern = new RegExp(hookTextPattern(stateBlock), "g");
  const stateMatches = [...text.matchAll(statePattern)];
  if (stateMatches.length !== 1) {
    throw new Error("Codex interrupt lifecycle hook trust state changed after setup; refusing to overwrite it");
  }
  const stateStart = stateMatches[0].index!;
  const stateEnd = stateStart + stateMatches[0][0].length;
  if (stateStart < headerEnd && stateEnd > first) {
    // The header and state patterns are built to be disjoint text; this only guards against a
    // future bug in that split ever producing overlapping ranges.
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }

  const endMarker = text.indexOf(MANAGED_INTERRUPT_HOOK_END);
  if (managedMarkerCount(text) !== 1 || endMarker < 0
    || (endMarker >= first && endMarker < headerEnd)
    || (endMarker >= stateStart && endMarker < stateEnd)
    || text.split(MANAGED_INTERRUPT_HOOK_END).length !== 2) {
    throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
  }
  if (endMarker < first) {
    // A moved comment is independent of the owned definitions. Prove it is still a comment,
    // rather than matching text inside an unrelated TOML value, before removing it separately.
    const precedingConfig = text.slice(0, first);
    const withoutMarker = precedingConfig.slice(0, endMarker)
      + precedingConfig.slice(endMarker + MANAGED_INTERRUPT_HOOK_END.length);
    try {
      if (JSON.stringify(canonicalJson(Bun.TOML.parse(precedingConfig)))
        !== JSON.stringify(canonicalJson(Bun.TOML.parse(withoutMarker)))) {
        throw new Error("Marker removal changes TOML values");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook markers changed after setup; refusing to overwrite them");
    }
  }
  if (codexInterruptHookHash(installed.command) !== installed.trustedHash) {
    throw new Error("Codex interrupt lifecycle hook journal hash is invalid");
  }
  // Codex's TOML editor inserts new tables before trailing comments. The end marker can therefore
  // move past unrelated config even though the owned hook fields remain unchanged. The relocated
  // state table's own span is excised first, if it happens to fall in the scanned region, so its
  // new position is never mistaken for an unexpected insertion.
  const scanEnd = endMarker < first ? text.length : endMarker;
  const appendedConfig = stateStart >= headerEnd && stateEnd <= scanEnd
    ? text.slice(headerEnd, stateStart) + text.slice(stateEnd, scanEnd)
    : text.slice(headerEnd, scanEnd);
  const firstAssignment = appendedConfig.split(/\r\n|\n|\r/)
    .map(line => line.trim()).find(line => line && !line.startsWith("#"));
  if (firstAssignment && !/^\[\[?.+\]\]?(?:\s*#.*)?$/.test(firstAssignment)) {
    throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
  }
  if (firstAssignment) {
    // A later table can also extend the owned hook or trust state. Compare those exact
    // definitions with Bun's TOML parser before treating the inserted tables as unrelated.
    const ownedDefinitions = (fragment: string): string => {
      const { hooks } = Bun.TOML.parse(fragment) as {
        hooks: { Interrupt: unknown[]; state: Record<string, unknown> };
      };
      return JSON.stringify(canonicalJson([hooks.Interrupt[0], hooks.state[installed.stateKey]]));
    };
    try {
      if (ownedDefinitions(ownedPrefix) !== ownedDefinitions(ownedPrefix + appendedConfig)) {
        throw new Error("Modified owned definitions");
      }
    } catch {
      throw new Error("Codex interrupt lifecycle hook changed after setup; refusing to overwrite it");
    }
  }
  const end = endMarker + MANAGED_INTERRUPT_HOOK_END.length;
  const trailing = installed.fragment.slice(marker + MANAGED_INTERRUPT_HOOK_END.length);
  const trailingLength = new RegExp("^" + hookTextPattern(trailing)).exec(text.slice(end))?.[0].length ?? 0;
  // When the state table still immediately follows the header (only blank-line whitespace between
  // them, the layout `installCodexInterruptHookCommand` writes), extend the header's deletion range
  // through that gap so removal leaves no blank-line residue behind, exactly as it did before the
  // header and state table were tracked as independently locatable spans.
  const gapToState = stateStart >= headerEnd ? text.slice(headerEnd, stateStart) : "";
  const headerDeleteEnd = stateStart >= headerEnd && /^(?:\r\n|\n|\r)*$/.test(gapToState)
    ? stateStart
    : headerEnd;
  return [
    { start: first, end: headerDeleteEnd },
    { start: stateStart, end: stateEnd },
    { start: endMarker, end: end + trailingLength },
  ];
}

export function verifyCodexInterruptHook(text: string, installed: InstalledCodexInterruptHook): void {
  locateCodexInterruptHook(text, installed);
}

export function restoreCodexInterruptHook(
  text: string,
  installed: InstalledCodexInterruptHook,
  options: { allowAbsent?: boolean } = {},
): string {
  // Explicit Setup can reinstall a fully removed hook. A stale journal alone does not mean
  // there is still a definition to remove; partial edits must retain the strict checks below.
  if (options.allowAbsent && managedMarkerCount(text) === 0 && !text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    const { hooks } = Bun.TOML.parse(text) as { hooks?: unknown };
    if (hooks === undefined) return text;
    if (hooks && typeof hooks === "object" && !Array.isArray(hooks) && !Object.hasOwn(hooks, "Interrupt")) {
      const state = (hooks as Record<string, unknown>).state;
      if (state === undefined || (state && typeof state === "object" && !Array.isArray(state)
        && !Object.hasOwn(state, installed.stateKey))) return text;
    }
  }
  const owned = locateCodexInterruptHook(text, installed).sort((left, right) => right.start - left.start);
  for (const range of owned) text = text.slice(0, range.start) + text.slice(range.end);
  return text;
}

export function verifyCodexInterruptHookRestored(text: string): void {
  if (managedMarkerCount(text) !== 0 || text.includes(MANAGED_INTERRUPT_HOOK_END)) {
    throw new Error("Codex interrupt lifecycle hook is present while the bridge is disconnected");
  }
}
