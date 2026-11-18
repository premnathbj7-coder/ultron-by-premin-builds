import crypto from "node:crypto";
import type { DeviceRecord, DeviceType, PublicDeviceRecord } from "./types";

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const DEVICE_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function generatePairingCode(length = 6): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PAIRING_ALPHABET[bytes[i] % PAIRING_ALPHABET.length];
  }
  return out;
}

export function generateDeviceToken(): string {
  return `ultron_${crypto.randomBytes(24).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function verifyTokenHash(token: string, expectedHash: string): boolean {
  if (!token || !expectedHash) return false;
  const candidate = hashToken(token);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function deriveDefaultAliases(name: string, type: DeviceType): string[] {
  const base = new Set<string>();
  const cleanName = name.trim().toLowerCase();
  if (cleanName) base.add(cleanName);

  if (type === "android") {
    base.add("phone");
    base.add("my phone");
    base.add("android");
    base.add("android phone");
    base.add("android device");
    base.add("mobile");
  } else if (type === "windows") {
    base.add("laptop");
    base.add("my laptop");
    base.add("windows");
    base.add("windows laptop");
    base.add("pc");
    base.add("my pc");
    base.add("desktop");
  } else if (type === "browser") {
    base.add("browser");
    base.add("companion");
    base.add("web device");
  }

  return Array.from(base);
}

export function buildQrPayload(params: {
  hubUrl: string;
  wsUrl: string;
  code: string;
  deviceName: string;
  deviceType: DeviceType;
  expiresAt: string;
}): string {
  return JSON.stringify({
    v: 1,
    service: "ultron-device-agent",
    hubUrl: params.hubUrl,
    wsUrl: params.wsUrl,
    code: params.code,
    deviceName: params.deviceName,
    deviceType: params.deviceType,
    expiresAt: params.expiresAt,
  });
}

export function toPublicDevice(device: DeviceRecord): PublicDeviceRecord {
  const { tokenHash: _omit, ...rest } = device;
  void _omit;
  return rest;
}
