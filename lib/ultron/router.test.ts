import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAppAlias,
  resolveTargetDevices,
  validateCommandPlan,
} from "./router";
import type { PublicDeviceRecord } from "./types";

function makeDevice(overrides: Partial<PublicDeviceRecord>): PublicDeviceRecord {
  return {
    id: "dev-1",
    name: "My Phone",
    aliases: ["my phone", "phone", "android"],
    type: "android",
    online: true,
    connectionStatus: "connected",
    batteryPercent: 82,
    isCharging: false,
    isLocked: false,
    supportedActions: [
      "OPEN_APPLICATION",
      "LOCK_DEVICE",
      "UNLOCK_REQUEST",
      "CHECK_BATTERY",
      "PING",
    ],
    installedApps: [
      { alias: "whatsapp", identifier: "com.whatsapp", displayName: "WhatsApp" },
      { alias: "youtube", identifier: "com.google.android.youtube", displayName: "YouTube" },
      { alias: "chrome", identifier: "com.android.chrome", displayName: "Google Chrome" },
    ],
    lastCommand: null,
    lastSeenAt: "2026-11-18T00:00:00.000Z",
    pairedAt: "2026-11-18T00:00:00.000Z",
    tokenExpiresAt: "2026-12-18T00:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

const phone = makeDevice({ id: "dev-phone", name: "My Phone", type: "android" });
const laptop = makeDevice({
  id: "dev-laptop",
  name: "Windows Laptop",
  aliases: ["my laptop", "laptop", "windows"],
  type: "windows",
  batteryPercent: 65,
  installedApps: [
    { alias: "vscode", identifier: "code.exe", displayName: "Visual Studio Code" },
    { alias: "chrome", identifier: "chrome.exe", displayName: "Google Chrome" },
  ],
});

test("normalizeAppAlias maps natural app names to canonical keys", () => {
  assert.equal(normalizeAppAlias("Visual Studio Code"), "vscode");
  assert.equal(normalizeAppAlias("VS Code"), "vscode");
  assert.equal(normalizeAppAlias("Google Chrome"), "chrome");
  assert.equal(normalizeAppAlias("WhatsApp"), "whatsapp");
});

test("resolveTargetDevices routes by alias, type, all, and skips revoked devices", () => {
  const revokedPhone = makeDevice({
    id: "dev-revoked",
    name: "Old Phone",
    revokedAt: "2026-11-18T00:00:00.000Z",
  });
  const devices = [phone, laptop, revokedPhone];

  const phoneMatch = resolveTargetDevices("my phone", devices);
  assert.equal(phoneMatch.devices.length, 1);
  assert.equal(phoneMatch.devices[0].id, "dev-phone");

  const laptopMatch = resolveTargetDevices("my laptop", devices);
  assert.equal(laptopMatch.devices.length, 1);
  assert.equal(laptopMatch.devices[0].id, "dev-laptop");

  const allMatch = resolveTargetDevices("all my devices", devices);
  assert.equal(allMatch.isBroadcastAll, true);
  assert.equal(allMatch.devices.length, 2);

  const ambiguous = resolveTargetDevices(null, devices);
  assert.equal(ambiguous.needsClarification, true);
});

test("validateCommandPlan allows opening installed app and rejects missing app", () => {
  const okPlan = validateCommandPlan(
    {
      intent: "OPEN_APPLICATION",
      targetDevice: "my phone",
      application: "WhatsApp",
      requiresConfirmation: false,
    },
    [phone, laptop],
  );
  assert.equal(okPlan.status, "ready");
  assert.equal(okPlan.dispatches.length, 1);
  assert.equal(okPlan.dispatches[0].application, "whatsapp");

  const missingPlan = validateCommandPlan(
    {
      intent: "OPEN_APPLICATION",
      targetDevice: "my phone",
      application: "Photoshop",
      requiresConfirmation: false,
    },
    [phone, laptop],
  );
  assert.equal(missingPlan.status, "error");
  assert.match(missingPlan.spokenResponse, /not in My Phone/i);
});

test("validateCommandPlan requires confirmation for LOCK_DEVICE until confirmed", () => {
  const unconfirmed = validateCommandPlan(
    {
      intent: "LOCK_DEVICE",
      targetDevice: "my phone",
      application: null,
      requiresConfirmation: true,
    },
    [phone],
  );
  assert.equal(unconfirmed.status, "confirmation_required");
  assert.ok(unconfirmed.pendingConfirmation);

  const confirmed = validateCommandPlan(
    {
      intent: "LOCK_DEVICE",
      targetDevice: "my phone",
      application: null,
      requiresConfirmation: true,
    },
    [phone],
    { confirmed: true },
  );
  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.dispatches[0].action, "LOCK_DEVICE");
});

test("validateCommandPlan reports offline device clearly and reflects real device status", () => {
  const offlinePhone = makeDevice({ id: "dev-phone", online: false, connectionStatus: "disconnected" });
  const openOffline = validateCommandPlan(
    {
      intent: "OPEN_APPLICATION",
      targetDevice: "my phone",
      application: "YouTube",
      requiresConfirmation: false,
    },
    [offlinePhone],
  );
  assert.equal(openOffline.status, "error");
  assert.match(openOffline.spokenResponse, /offline/i);

  const statusResp = validateCommandPlan(
    {
      intent: "LIST_DEVICES",
      targetDevice: null,
      application: null,
      requiresConfirmation: false,
    },
    [phone, makeDevice({ id: "dev-laptop", name: "Windows Laptop", online: false })],
  );
  assert.equal(statusResp.status, "immediate_response");
  assert.match(statusResp.spokenResponse, /My Phone is connected/i);
  assert.match(statusResp.spokenResponse, /Offline: Windows Laptop/i);
});
