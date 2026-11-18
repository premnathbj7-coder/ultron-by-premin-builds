import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  appendAuditLog,
  authenticateDeviceToken,
  getPublicDevice,
  listActivePairings,
  listAuditLogs,
  listPublicDevices,
  revokeDevice,
  updateDeviceTelemetry,
} from "./store";
import type {
  AgentCommandPayload,
  AgentCommandResult,
  DeviceAction,
  HudSocketEvent,
  InstalledApp,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

interface PendingCommand {
  resolve: (result: AgentCommandResult) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
}

interface HubRuntime {
  agentServer: WebSocketServer;
  hudServer: WebSocketServer;
  agentSockets: Map<string, WebSocket>;
  hudSockets: Set<WebSocket>;
  pendingCommands: Map<string, PendingCommand>;
}

declare global {
  var __ultronWsHub: HubRuntime | undefined;
}

function getRuntime(): HubRuntime {
  if (globalThis.__ultronWsHub) {
    return globalThis.__ultronWsHub;
  }

  const agentServer = new WebSocketServer({ noServer: true });
  const hudServer = new WebSocketServer({ noServer: true });
  const agentSockets = new Map<string, WebSocket>();
  const hudSockets = new Set<WebSocket>();
  const pendingCommands = new Map<string, PendingCommand>();

  const runtime: HubRuntime = {
    agentServer,
    hudServer,
    agentSockets,
    hudSockets,
    pendingCommands,
  };

  hudServer.on("connection", (ws) => {
    hudSockets.add(ws);
    const snapshot: HudSocketEvent = {
      type: "state:snapshot",
      devices: listPublicDevices(),
      auditLogs: listAuditLogs(60),
      pairings: listActivePairings(),
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("close", () => {
      hudSockets.delete(ws);
    });
    ws.on("error", () => {
      hudSockets.delete(ws);
    });
  });

  agentServer.on("connection", (ws, req, deviceFromAuth?: PublicDeviceRecord) => {
    const device = deviceFromAuth;
    if (!device) {
      ws.close(4001, "UNAUTHORIZED");
      return;
    }

    // Close any stale socket for the same device
    const existing = agentSockets.get(device.id);
    if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
      existing.close(4002, "SUPERSEDED");
    }

    agentSockets.set(device.id, ws);
    const updated = updateDeviceTelemetry(device.id, {
      online: true,
      connectionStatus: "connected",
      lastSeenAt: new Date().toISOString(),
    });
    if (updated) {
      broadcastHud({ type: "device:updated", device: updated });
    }

    ws.on("message", (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          type?: string;
          osVersion?: string;
          batteryPercent?: number | null;
          isCharging?: boolean | null;
          isLocked?: boolean | null;
          supportedActions?: DeviceAction[];
          installedApps?: InstalledApp[];
          commandId?: string;
          success?: boolean;
          errorCode?: AgentCommandResult["errorCode"];
          message?: string;
          data?: Record<string, unknown>;
        };

        if (msg.type === "agent:hello" || msg.type === "agent:telemetry") {
          const patch: Parameters<typeof updateDeviceTelemetry>[1] = {
            online: true,
            connectionStatus: "connected",
            lastSeenAt: new Date().toISOString(),
          };
          if (typeof msg.osVersion === "string") patch.osVersion = msg.osVersion;
          if (msg.batteryPercent !== undefined) patch.batteryPercent = msg.batteryPercent;
          if (msg.isCharging !== undefined) patch.isCharging = msg.isCharging;
          if (msg.isLocked !== undefined) patch.isLocked = msg.isLocked;
          if (Array.isArray(msg.supportedActions)) {
            patch.supportedActions = msg.supportedActions;
          }
          if (Array.isArray(msg.installedApps)) {
            patch.installedApps = msg.installedApps;
          }
          const refreshed = updateDeviceTelemetry(device.id, patch);
          if (refreshed) {
            broadcastHud({ type: "device:updated", device: refreshed });
          }
          return;
        }

        if (msg.type === "agent:heartbeat") {
          const refreshed = updateDeviceTelemetry(device.id, {
            online: true,
            connectionStatus: "connected",
            lastSeenAt: new Date().toISOString(),
            ...(msg.batteryPercent !== undefined
              ? { batteryPercent: msg.batteryPercent }
              : {}),
            ...(msg.isCharging !== undefined ? { isCharging: msg.isCharging } : {}),
            ...(msg.isLocked !== undefined ? { isLocked: msg.isLocked } : {}),
          });
          if (refreshed) {
            broadcastHud({ type: "device:updated", device: refreshed });
          }
          ws.send(JSON.stringify({ type: "hub:pong", timestamp: new Date().toISOString() }));
          return;
        }

        if (msg.type === "agent:command_result" && msg.commandId) {
          const pending = pendingCommands.get(msg.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingCommands.delete(msg.commandId);
            pending.resolve({
              commandId: msg.commandId,
              success: Boolean(msg.success),
              errorCode: msg.errorCode,
              message: msg.message ?? (msg.success ? "Executed." : "Failed."),
              batteryPercent: msg.batteryPercent,
              isCharging: msg.isCharging,
              isLocked: msg.isLocked,
              data: msg.data,
            });
          }
        }
      } catch (err) {
        console.warn("[ULTRON WS] Invalid message from agent:", err);
      }
    });

    ws.on("close", () => {
      if (agentSockets.get(device.id) === ws) {
        agentSockets.delete(device.id);
        const current = getPublicDevice(device.id);
        if (current) {
          const offline = updateDeviceTelemetry(device.id, {
            online: false,
            connectionStatus: current.revokedAt ? "revoked" : "disconnected",
            lastSeenAt: new Date().toISOString(),
          });
          if (offline) {
            broadcastHud({ type: "device:updated", device: offline });
          }
        }
      }
    });

    ws.on("error", () => {
      if (agentSockets.get(device.id) === ws) {
        agentSockets.delete(device.id);
      }
    });
  });

  globalThis.__ultronWsHub = runtime;
  return runtime;
}

export function broadcastHud(event: HudSocketEvent): void {
  const { hudSockets } = getRuntime();
  const payload = JSON.stringify(event);
  for (const ws of hudSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

export function broadcastAuditEntry(entry: ReturnType<typeof appendAuditLog>): void {
  broadcastHud({ type: "audit:appended", entry });
}

export function handleWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  const runtime = getRuntime();

  if (url.pathname === "/ws/hud") {
    runtime.hudServer.handleUpgrade(req, socket, head, (ws) => {
      runtime.hudServer.emit("connection", ws, req);
    });
    return true;
  }

  if (url.pathname === "/ws/agent") {
    const authHeader = req.headers.authorization;
    const bearer =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
    const token = bearer || url.searchParams.get("token")?.trim() || "";
    const device = authenticateDeviceToken(token);

    if (!device) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return true;
    }

    runtime.agentServer.handleUpgrade(req, socket, head, (ws) => {
      (runtime.agentServer as WebSocketServer).emit("connection", ws, req, device);
    });
    return true;
  }

  return false;
}

export function disconnectAgentSocket(deviceId: string, reason = "DISCONNECTED_BY_HUB"): void {
  const { agentSockets } = getRuntime();
  const ws = agentSockets.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(4000, reason);
  }
  agentSockets.delete(deviceId);
  const updated = updateDeviceTelemetry(deviceId, {
    online: false,
    connectionStatus: "disconnected",
  });
  if (updated) {
    broadcastHud({ type: "device:updated", device: updated });
  }
}

export function revokeAndDisconnectDevice(deviceId: string): PublicDeviceRecord | null {
  const { agentSockets } = getRuntime();
  const ws = agentSockets.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(4003, "TOKEN_REVOKED");
  }
  agentSockets.delete(deviceId);
  const revoked = revokeDevice(deviceId);
  if (revoked) {
    broadcastHud({ type: "device:updated", device: revoked });
  }
  return revoked;
}

export async function dispatchCommandToAgent(params: {
  deviceId: string;
  action: DeviceAction;
  application?: string | null;
  requestedBy: "voice" | "text" | "ui";
  timeoutMs?: number;
}): Promise<AgentCommandResult> {
  const { agentSockets, pendingCommands } = getRuntime();
  const ws = agentSockets.get(params.deviceId);
  const device = getPublicDevice(params.deviceId);

  if (!device || device.revokedAt) {
    return {
      commandId: crypto.randomUUID(),
      success: false,
      errorCode: "PERMISSION_DENIED",
      message: "Device access has been revoked or device is unknown.",
    };
  }

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    updateDeviceTelemetry(params.deviceId, {
      online: false,
      connectionStatus: "disconnected",
    });
    return {
      commandId: crypto.randomUUID(),
      success: false,
      errorCode: "EXECUTION_FAILED",
      message: `${device.name} is offline or WebSocket connection was interrupted.`,
    };
  }

  const commandId = crypto.randomUUID();
  const payload: AgentCommandPayload = {
    commandId,
    action: params.action,
    application: params.application ?? null,
    requestedBy: params.requestedBy,
    issuedAt: new Date().toISOString(),
  };

  const timeoutMs = params.timeoutMs ?? 12_000;

  const result = await new Promise<AgentCommandResult>((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      resolve({
        commandId,
        success: false,
        errorCode: "EXECUTION_FAILED",
        message: `${device.name} did not acknowledge the command within ${Math.round(timeoutMs / 1000)}s.`,
      });
    }, timeoutMs);

    pendingCommands.set(commandId, {
      resolve,
      timer,
      deviceId: params.deviceId,
    });

    try {
      ws.send(JSON.stringify({ type: "hub:command", ...payload }));
    } catch {
      clearTimeout(timer);
      pendingCommands.delete(commandId);
      resolve({
        commandId,
        success: false,
        errorCode: "EXECUTION_FAILED",
        message: `Failed to send command to ${device.name}.`,
      });
    }
  });

  const updated = updateDeviceTelemetry(params.deviceId, {
    ...(result.batteryPercent !== undefined
      ? { batteryPercent: result.batteryPercent }
      : {}),
    ...(result.isCharging !== undefined ? { isCharging: result.isCharging } : {}),
    ...(result.isLocked !== undefined ? { isLocked: result.isLocked } : {}),
    lastSeenAt: new Date().toISOString(),
    lastCommand: {
      action: params.action,
      application: params.application ?? null,
      status: result.success ? "succeeded" : "failed",
      message: result.message,
      timestamp: new Date().toISOString(),
    },
  });

  if (updated) {
    broadcastHud({ type: "device:updated", device: updated });
  }

  return result;
}
