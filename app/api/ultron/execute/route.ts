import { NextRequest, NextResponse } from "next/server";
import { appendAuditLog, getPublicDevice, listPublicDevices } from "@/lib/server/store";
import {
  broadcastAuditEntry,
  dispatchCommandToAgent,
} from "@/lib/server/wsHub";
import { findInstalledApp, formatAppDisplayName, normalizeAppAlias } from "@/lib/ultron/router";
import type {
  AgentCommandResult,
  CommandIntentType,
  DeviceAction,
} from "@/lib/ultron/types";

const ALLOWED_ACTIONS: ReadonlySet<DeviceAction> = new Set([
  "OPEN_APPLICATION",
  "LOCK_DEVICE",
  "UNLOCK_REQUEST",
  "CHECK_BATTERY",
  "PING",
]);

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: DeviceAction;
      targetDeviceIds?: string[];
      application?: string | null;
      confirmed?: boolean;
      source?: "voice" | "text" | "ui";
      rawCommand?: string;
    };

    const action = body.action;
    if (!action || !ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json(
        { error: "Unsupported or invalid device action." },
        { status: 400 },
      );
    }

    if (action === "LOCK_DEVICE" && !body.confirmed) {
      return NextResponse.json(
        {
          status: "confirmation_required",
          spokenResponse: "Explicit confirmation is required before locking a device.",
        },
        { status: 409 },
      );
    }

    const ids = Array.isArray(body.targetDeviceIds) ? body.targetDeviceIds : [];
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "At least one target device ID is required." },
        { status: 400 },
      );
    }

    const source = body.source ?? "ui";
    const allDevices = listPublicDevices();
    const results: Array<{
      deviceId: string;
      deviceName: string;
      result: AgentCommandResult;
    }> = [];

    for (const id of ids) {
      const device = getPublicDevice(id) ?? allDevices.find((d) => d.id === id) ?? null;
      if (!device || device.revokedAt) {
        results.push({
          deviceId: id,
          deviceName: device?.name ?? id,
          result: {
            commandId: "rejected",
            success: false,
            errorCode: "PERMISSION_DENIED",
            message: "Device not found or access has been revoked.",
          },
        });
        continue;
      }

      if (!device.online) {
        const msg = `${device.name} is offline.`;
        const entry = appendAuditLog({
          source,
          rawCommand: body.rawCommand ?? `${action} (${device.name})`,
          intent: (action === "PING" ? "LIST_DEVICES" : action) as CommandIntentType,
          targetDeviceId: device.id,
          targetDeviceName: device.name,
          status: "rejected",
          detail: msg,
        });
        broadcastAuditEntry(entry);
        results.push({
          deviceId: device.id,
          deviceName: device.name,
          result: {
            commandId: "offline",
            success: false,
            errorCode: "EXECUTION_FAILED",
            message: msg,
          },
        });
        continue;
      }

      let appToSend: string | null = null;
      if (action === "OPEN_APPLICATION") {
        const rawApp = (body.application ?? "").trim();
        if (!rawApp) {
          return NextResponse.json(
            { error: "Application name is required for OPEN_APPLICATION." },
            { status: 400 },
          );
        }
        if (device.installedApps.length > 0) {
          const found = findInstalledApp(device.installedApps, rawApp);
          if (!found) {
            const msg = `${formatAppDisplayName(rawApp)} is not installed or allowlisted on ${device.name}.`;
            const entry = appendAuditLog({
              source,
              rawCommand: body.rawCommand ?? `Open ${rawApp} on ${device.name}`,
              intent: "OPEN_APPLICATION",
              targetDeviceId: device.id,
              targetDeviceName: device.name,
              status: "rejected",
              detail: msg,
            });
            broadcastAuditEntry(entry);
            results.push({
              deviceId: device.id,
              deviceName: device.name,
              result: {
                commandId: "not-installed",
                success: false,
                errorCode: "APP_NOT_INSTALLED",
                message: msg,
              },
            });
            continue;
          }
          appToSend = found.alias;
        } else {
          appToSend = normalizeAppAlias(rawApp);
        }
      }

      const res = await dispatchCommandToAgent({
        deviceId: device.id,
        action,
        application: appToSend,
        requestedBy: source,
      });

      const entry = appendAuditLog({
        source,
        rawCommand: body.rawCommand ?? `${action} ${appToSend ?? ""} (${device.name})`.trim(),
        intent: (action === "PING" ? "LIST_DEVICES" : action) as CommandIntentType,
        targetDeviceId: device.id,
        targetDeviceName: device.name,
        status: res.success ? "succeeded" : "failed",
        detail: res.message,
      });
      broadcastAuditEntry(entry);

      results.push({
        deviceId: device.id,
        deviceName: device.name,
        result: res,
      });
    }

    const spokenResponse = results.map((r) => r.result.message).join(" ");
    const allOk = results.every((r) => r.result.success);

    return NextResponse.json({
      status: allOk ? "succeeded" : "partial_or_failed",
      spokenResponse,
      results,
    });
  } catch (err) {
    console.error("[ULTRON Execute POST]", err);
    return NextResponse.json(
      { error: "Failed to execute device action." },
      { status: 500 },
    );
  }
}
