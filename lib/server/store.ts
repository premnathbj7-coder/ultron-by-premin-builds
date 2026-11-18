import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEVICE_TOKEN_TTL_MS,
  PAIRING_TTL_MS,
  buildQrPayload,
  deriveDefaultAliases,
  generateDeviceToken,
  generatePairingCode,
  hashToken,
  toPublicDevice,
  verifyTokenHash,
} from "@/lib/ultron/security";
import type {
  AuditEntry,
  AuditStatus,
  CommandIntentType,
  DeviceAction,
  DeviceRecord,
  DeviceType,
  InstalledApp,
  LastCommandSummary,
  PairingChallenge,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

interface PersistedState {
  devices: DeviceRecord[];
  pairings: PairingChallenge[];
  auditLogs: AuditEntry[];
}

const DATA_DIR = path.join(process.cwd(), ".ultron-data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const MAX_AUDIT_LOGS = 400;

declare global {
  var __ultronStoreState: PersistedState | undefined;
}

function loadState(): PersistedState {
  if (globalThis.__ultronStoreState) {
    return globalThis.__ultronStoreState;
  }

  let initial: PersistedState = {
    devices: [],
    pairings: [],
    auditLogs: [],
  };

  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      initial = {
        devices: Array.isArray(parsed.devices)
          ? parsed.devices.map((d) => ({
              ...d,
              // On fresh boot, no WebSocket agent is connected until it reconnects
              online: false,
              connectionStatus: d.revokedAt ? "revoked" : "disconnected",
            }))
          : [],
        pairings: Array.isArray(parsed.pairings) ? parsed.pairings : [],
        auditLogs: Array.isArray(parsed.auditLogs) ? parsed.auditLogs : [],
      };
    }
  } catch (err) {
    console.warn("[ULTRON Store] Failed to read persisted state, starting fresh:", err);
  }

  globalThis.__ultronStoreState = initial;
  return initial;
}

function saveState(state: PersistedState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_FILE);
  } catch (err) {
    console.error("[ULTRON Store] Failed to persist state:", err);
  }
}

function pruneExpiredPairings(state: PersistedState): void {
  const now = Date.now();
  state.pairings = state.pairings.filter(
    (p) => !p.consumedAt && new Date(p.expiresAt).getTime() > now,
  );
}

export function listPublicDevices(): PublicDeviceRecord[] {
  const state = loadState();
  return state.devices.map(toPublicDevice);
}

export function getPublicDevice(id: string): PublicDeviceRecord | null {
  const state = loadState();
  const found = state.devices.find((d) => d.id === id);
  return found ? toPublicDevice(found) : null;
}

export function listActivePairings(): PairingChallenge[] {
  const state = loadState();
  pruneExpiredPairings(state);
  return [...state.pairings];
}

export function listAuditLogs(limit = 60): AuditEntry[] {
  const state = loadState();
  return state.auditLogs.slice(0, limit);
}

export function appendAuditLog(input: {
  source: "voice" | "text" | "ui";
  rawCommand: string;
  intent: CommandIntentType;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
  status: AuditStatus;
  detail: string;
}): AuditEntry {
  const state = loadState();
  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...input,
  };
  state.auditLogs.unshift(entry);
  if (state.auditLogs.length > MAX_AUDIT_LOGS) {
    state.auditLogs.length = MAX_AUDIT_LOGS;
  }
  saveState(state);
  return entry;
}

export function createPairingChallenge(params: {
  deviceName: string;
  deviceType: DeviceType;
  customAliases?: string[];
  hubUrl: string;
  wsUrl: string;
}): PairingChallenge {
  const state = loadState();
  pruneExpiredPairings(state);

  const cleanName = params.deviceName.trim() || `${params.deviceType.toUpperCase()} Device`;
  let code = generatePairingCode();
  while (state.pairings.some((p) => p.code === code)) {
    code = generatePairingCode();
  }

  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  const aliases = Array.from(
    new Set([
      ...deriveDefaultAliases(cleanName, params.deviceType),
      ...(params.customAliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean),
    ]),
  );

  const qrPayload = buildQrPayload({
    hubUrl: params.hubUrl,
    wsUrl: params.wsUrl,
    code,
    deviceName: cleanName,
    deviceType: params.deviceType,
    expiresAt,
  });

  const challenge: PairingChallenge = {
    code,
    deviceName: cleanName,
    deviceType: params.deviceType,
    aliases,
    createdAt,
    expiresAt,
    consumedAt: null,
    qrPayload,
  };

  state.pairings.unshift(challenge);
  saveState(state);
  return challenge;
}

export function redeemPairingCode(params: {
  code: string;
  deviceName?: string;
  osVersion?: string;
  supportedActions?: DeviceAction[];
  installedApps?: InstalledApp[];
}): {
  device: PublicDeviceRecord;
  token: string;
  tokenExpiresAt: string;
} | null {
  const state = loadState();
  pruneExpiredPairings(state);

  const normalizedCode = params.code.trim().toUpperCase();
  const idx = state.pairings.findIndex((p) => p.code === normalizedCode && !p.consumedAt);
  if (idx === -1) return null;

  const challenge = state.pairings[idx];
  challenge.consumedAt = new Date().toISOString();
  state.pairings.splice(idx, 1);

  const rawToken = generateDeviceToken();
  const tokenExpiresAt = new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString();
  const nowIso = new Date().toISOString();
  const finalName = params.deviceName?.trim() || challenge.deviceName;
  const aliases = Array.from(
    new Set([
      ...challenge.aliases,
      ...deriveDefaultAliases(finalName, challenge.deviceType),
    ]),
  );

  const defaultActions: DeviceAction[] =
    challenge.deviceType === "windows"
      ? ["OPEN_APPLICATION", "LOCK_DEVICE", "UNLOCK_REQUEST", "CHECK_BATTERY", "PING"]
      : challenge.deviceType === "android"
        ? ["OPEN_APPLICATION", "LOCK_DEVICE", "UNLOCK_REQUEST", "CHECK_BATTERY", "PING"]
        : ["OPEN_APPLICATION", "LOCK_DEVICE", "UNLOCK_REQUEST", "CHECK_BATTERY", "PING"];

  const record: DeviceRecord = {
    id: crypto.randomUUID(),
    name: finalName,
    aliases,
    type: challenge.deviceType,
    osVersion: params.osVersion,
    online: false,
    connectionStatus: "disconnected",
    batteryPercent: null,
    isCharging: null,
    isLocked: false,
    supportedActions:
      params.supportedActions && params.supportedActions.length > 0
        ? params.supportedActions
        : defaultActions,
    installedApps: params.installedApps ?? [],
    lastCommand: null,
    lastSeenAt: nowIso,
    pairedAt: nowIso,
    tokenHash: hashToken(rawToken),
    tokenExpiresAt,
    revokedAt: null,
  };

  state.devices.push(record);
  saveState(state);

  return {
    device: toPublicDevice(record),
    token: rawToken,
    tokenExpiresAt,
  };
}

export function authenticateDeviceToken(token: string): PublicDeviceRecord | null {
  const state = loadState();
  const now = Date.now();
  for (const device of state.devices) {
    if (device.revokedAt) continue;
    if (new Date(device.tokenExpiresAt).getTime() <= now) continue;
    if (verifyTokenHash(token, device.tokenHash)) {
      return toPublicDevice(device);
    }
  }
  return null;
}

export function updateDeviceTelemetry(
  id: string,
  patch: Partial<{
    online: boolean;
    connectionStatus: DeviceRecord["connectionStatus"];
    osVersion: string;
    batteryPercent: number | null;
    isCharging: boolean | null;
    isLocked: boolean | null;
    supportedActions: DeviceAction[];
    installedApps: InstalledApp[];
    lastCommand: LastCommandSummary;
    lastSeenAt: string;
  }>,
): PublicDeviceRecord | null {
  const state = loadState();
  const device = state.devices.find((d) => d.id === id);
  if (!device) return null;

  Object.assign(device, patch);
  if (device.revokedAt) {
    device.online = false;
    device.connectionStatus = "revoked";
  }
  saveState(state);
  return toPublicDevice(device);
}

export function renameDevice(
  id: string,
  name: string,
  extraAliases?: string[],
): PublicDeviceRecord | null {
  const state = loadState();
  const device = state.devices.find((d) => d.id === id);
  if (!device) return null;

  const clean = name.trim();
  if (!clean) return null;
  device.name = clean;
  device.aliases = Array.from(
    new Set([
      ...deriveDefaultAliases(clean, device.type),
      ...(extraAliases ?? device.aliases).map((a) => a.trim().toLowerCase()).filter(Boolean),
    ]),
  );
  saveState(state);
  return toPublicDevice(device);
}

export function revokeDevice(id: string): PublicDeviceRecord | null {
  const state = loadState();
  const device = state.devices.find((d) => d.id === id);
  if (!device) return null;

  device.revokedAt = new Date().toISOString();
  device.online = false;
  device.connectionStatus = "revoked";
  saveState(state);
  return toPublicDevice(device);
}
