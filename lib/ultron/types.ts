export type DeviceType = "windows" | "android" | "browser";

export type DeviceAction =
  | "OPEN_APPLICATION"
  | "LOCK_DEVICE"
  | "UNLOCK_REQUEST"
  | "CHECK_BATTERY"
  | "PING";

import type { EnergyThemeId } from "./themes";

export type CommandIntentType =
  | "OPEN_APPLICATION"
  | "LIST_DEVICES"
  | "CHECK_BATTERY"
  | "LOCK_DEVICE"
  | "UNLOCK_REQUEST"
  | "SET_THEME"
  | "HELP"
  | "UNKNOWN";

export type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "pairing"
  | "revoked";

export interface InstalledApp {
  alias: string;
  identifier: string;
  displayName: string;
}

export interface LastCommandSummary {
  action: DeviceAction;
  application?: string | null;
  status: "succeeded" | "failed";
  message: string;
  timestamp: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  aliases: string[];
  type: DeviceType;
  osVersion?: string;
  online: boolean;
  connectionStatus: ConnectionStatus;
  batteryPercent: number | null;
  isCharging: boolean | null;
  isLocked: boolean | null;
  supportedActions: DeviceAction[];
  installedApps: InstalledApp[];
  lastCommand: LastCommandSummary | null;
  lastSeenAt: string | null;
  pairedAt: string;
  tokenHash: string;
  tokenExpiresAt: string;
  revokedAt: string | null;
}

export type PublicDeviceRecord = Omit<DeviceRecord, "tokenHash">;

export interface PairingChallenge {
  code: string;
  deviceName: string;
  deviceType: DeviceType;
  aliases: string[];
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  qrPayload: string;
}

export interface ParsedCommandIntent {
  intent: CommandIntentType;
  targetDevice: string | null;
  application: string | null;
  theme?: EnergyThemeId | null;
  requiresConfirmation: boolean;
  spokenSummary?: string;
}

export type AuditStatus =
  | "pending_confirmation"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "rejected";

export interface AuditEntry {
  id: string;
  timestamp: string;
  source: "voice" | "text" | "ui";
  rawCommand: string;
  intent: CommandIntentType;
  targetDeviceId: string | null;
  targetDeviceName: string | null;
  status: AuditStatus;
  detail: string;
}

export interface AgentCommandPayload {
  commandId: string;
  action: DeviceAction;
  application?: string | null;
  requestedBy: "voice" | "text" | "ui";
  issuedAt: string;
}

export interface AgentCommandResult {
  commandId: string;
  success: boolean;
  errorCode?:
    | "APP_NOT_INSTALLED"
    | "DEVICE_LOCKED"
    | "BACKGROUND_LAUNCH_BLOCKED"
    | "PERMISSION_DENIED"
    | "UNSUPPORTED_OPERATION"
    | "EXECUTION_FAILED";
  message: string;
  batteryPercent?: number | null;
  isCharging?: boolean | null;
  isLocked?: boolean | null;
  data?: Record<string, unknown>;
}

export type HudSocketEvent =
  | {
      type: "state:snapshot";
      devices: PublicDeviceRecord[];
      auditLogs: AuditEntry[];
      pairings: PairingChallenge[];
    }
  | {
      type: "device:updated";
      device: PublicDeviceRecord;
    }
  | {
      type: "audit:appended";
      entry: AuditEntry;
    };
