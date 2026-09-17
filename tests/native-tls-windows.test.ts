import { expect, test } from "bun:test";
import { windowsExtraTrustedCa } from "../src/native-tls-windows";

test("non-Windows platforms never invoke the certificate-store reader", async () => {
  let calls = 0;
  const result = await windowsExtraTrustedCa("linux", async () => {
    calls++;
    return { code: 0, stdout: "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n" };
  });
  expect(result).toBeUndefined();
  expect(calls).toBe(0);
});

test("Windows success returns the trimmed PEM output from the OS certificate store", async () => {
  const pem = "-----BEGIN CERTIFICATE-----\nfake-corporate-root\n-----END CERTIFICATE-----";
  const result = await windowsExtraTrustedCa("win32", async () => ({ code: 0, stdout: `${pem}\n\n` }));
  expect(result).toBe(pem);
});

test("a non-zero exit code from the reader fails open (no extra CA, no throw)", async () => {
  const result = await windowsExtraTrustedCa("win32", async () => ({ code: 1, stdout: "" }));
  expect(result).toBeUndefined();
});

test("output without any certificate block fails open", async () => {
  const result = await windowsExtraTrustedCa("win32", async () => ({ code: 0, stdout: "\n" }));
  expect(result).toBeUndefined();
});

test("a reader that throws (e.g. powershell.exe missing) fails open, never rejects", async () => {
  const result = await windowsExtraTrustedCa("win32", async () => {
    throw new Error("spawn powershell.exe ENOENT");
  });
  expect(result).toBeUndefined();
});
