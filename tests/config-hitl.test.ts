import { expect, test } from "bun:test";
import { resolveHitlActivation } from "../src/config";

test("resolveHitlActivation enables HITL only for browser-only mode with an attached TTY", () => {
  expect(resolveHitlActivation(true, "browser-only", true)).toEqual({ enabled: true });
});

test("resolveHitlActivation refuses full mode even if a TTY is attached", () => {
  const result = resolveHitlActivation(true, "full", true);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HITL requires browser-only mode; the daemon is running in full mode. HITL is disabled for this process.",
  );
});

test("resolveHitlActivation refuses a headless daemon even in browser-only mode", () => {
  const result = resolveHitlActivation(true, "browser-only", false);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HITL requires an attached terminal (process.stdin.isTTY); this daemon process is headless. HITL is disabled for this process.",
  );
});

test("resolveHitlActivation is inert when HITL was not requested", () => {
  expect(resolveHitlActivation(false, "browser-only", true)).toEqual({ enabled: false });
});
