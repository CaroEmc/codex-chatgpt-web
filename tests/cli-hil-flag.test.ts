import { expect, test } from "bun:test";
import { resolveSetupModeFlags } from "../src/cli";

test("--hil combined with --full is rejected with a clear error", () => {
  expect(() => resolveSetupModeFlags(["--full", "--hil"])).toThrow(/--hil requires --browser-only/);
});

test("--hil alone with --browser-only is accepted", () => {
  const result = resolveSetupModeFlags(["--browser-only", "--hil"]);
  expect(result.hil).toBe(true);
  expect(result.browserOnly).toBe(true);
  expect(result.full).toBe(false);
});

test("neither --hil nor a conflicting mode still enforces exactly one setup mode", () => {
  expect(() => resolveSetupModeFlags([])).toThrow(/Choose exactly one setup mode/);
});

test("--browser-only without --hil leaves hil false", () => {
  const result = resolveSetupModeFlags(["--browser-only"]);
  expect(result.hil).toBe(false);
});
