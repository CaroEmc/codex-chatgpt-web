import { expect, test } from "bun:test";
import { resolveSetupModeFlags } from "../src/cli";

test("--hitl combined with --full is rejected with a clear error", () => {
  expect(() => resolveSetupModeFlags(["--full", "--hitl"])).toThrow(/--hitl requires --browser-only/);
});

test("--hitl alone with --browser-only is accepted", () => {
  const result = resolveSetupModeFlags(["--browser-only", "--hitl"]);
  expect(result.hitl).toBe(true);
  expect(result.browserOnly).toBe(true);
  expect(result.full).toBe(false);
});

test("neither --hitl nor a conflicting mode still enforces exactly one setup mode", () => {
  expect(() => resolveSetupModeFlags([])).toThrow(/Choose exactly one setup mode/);
});

test("--browser-only without --hitl leaves hitl false", () => {
  const result = resolveSetupModeFlags(["--browser-only"]);
  expect(result.hitl).toBe(false);
});
