import { expect, test } from "bun:test";
import { resolveHilActivation } from "../src/config";

test("resolveHilActivation enables HIL only for browser-only mode with an attached TTY", () => {
  expect(resolveHilActivation(true, "browser-only", true)).toEqual({ enabled: true });
});

test("resolveHilActivation refuses full mode even if a TTY is attached", () => {
  const result = resolveHilActivation(true, "full", true);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HIL requires browser-only mode; the daemon is running in full mode. HIL is disabled for this process.",
  );
});

test("resolveHilActivation refuses a headless daemon even in browser-only mode", () => {
  const result = resolveHilActivation(true, "browser-only", false);
  expect(result.enabled).toBe(false);
  expect(result.warning).toBe(
    "HIL requires an attached terminal (process.stdin.isTTY); this daemon process is headless. HIL is disabled for this process.",
  );
});

test("resolveHilActivation is inert when HIL was not requested", () => {
  expect(resolveHilActivation(false, "browser-only", true)).toEqual({ enabled: false });
});
