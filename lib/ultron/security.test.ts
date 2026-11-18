import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQrPayload,
  deriveDefaultAliases,
  generateDeviceToken,
  generatePairingCode,
  hashToken,
  verifyTokenHash,
} from "./security";

test("generatePairingCode creates 6-char unambiguous uppercase codes", () => {
  const code = generatePairingCode();
  assert.equal(code.length, 6);
  assert.match(code, /^[A-Z2-9]{6}$/);
  assert.equal(/[01OIL]/.test(code), false);
});

test("generateDeviceToken and verifyTokenHash validate tokens with timing-safe equality", () => {
  const token = generateDeviceToken();
  assert.ok(token.startsWith("ultron_"));
  const digest = hashToken(token);
  assert.equal(digest.length, 64);
  assert.equal(verifyTokenHash(token, digest), true);
  assert.equal(verifyTokenHash(token + "x", digest), false);
  assert.equal(verifyTokenHash("", digest), false);
});

test("deriveDefaultAliases assigns platform-appropriate voice aliases", () => {
  const androidAliases = deriveDefaultAliases("Sagar Pixel", "android");
  assert.ok(androidAliases.includes("sagar pixel"));
  assert.ok(androidAliases.includes("my phone"));
  assert.ok(androidAliases.includes("android device"));

  const windowsAliases = deriveDefaultAliases("Work Laptop", "windows");
  assert.ok(windowsAliases.includes("work laptop"));
  assert.ok(windowsAliases.includes("my laptop"));
  assert.ok(windowsAliases.includes("windows"));
});

test("buildQrPayload outputs valid JSON without embedding raw tokens", () => {
  const payloadStr = buildQrPayload({
    hubUrl: "http://192.168.1.5:3000",
    wsUrl: "ws://192.168.1.5:3000/ws/agent",
    code: "AB23CD",
    deviceName: "My Phone",
    deviceType: "android",
    expiresAt: "2026-11-18T01:00:00.000Z",
  });
  const parsed = JSON.parse(payloadStr);
  assert.equal(parsed.code, "AB23CD");
  assert.equal(parsed.service, "ultron-device-agent");
  assert.equal(parsed.token, undefined);
});
