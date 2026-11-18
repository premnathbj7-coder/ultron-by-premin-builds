import { NextRequest, NextResponse } from "next/server";
import { appendAuditLog, redeemPairingCode } from "@/lib/server/store";
import { broadcastAuditEntry, broadcastHud } from "@/lib/server/wsHub";
import type { DeviceAction, InstalledApp } from "@/lib/ultron/types";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      code?: string;
      deviceName?: string;
      osVersion?: string;
      supportedActions?: DeviceAction[];
      installedApps?: InstalledApp[];
    };

    const code = (body.code ?? "").trim();
    if (!code) {
      return NextResponse.json(
        { error: "Pairing code is required." },
        { status: 400 },
      );
    }

    const redeemed = redeemPairingCode({
      code,
      deviceName: body.deviceName,
      osVersion: body.osVersion,
      supportedActions: body.supportedActions,
      installedApps: body.installedApps,
    });

    if (!redeemed) {
      return NextResponse.json(
        { error: "Invalid, expired, or already-used pairing code." },
        { status: 401 },
      );
    }

    broadcastHud({ type: "device:updated", device: redeemed.device });
    const entry = appendAuditLog({
      source: "ui",
      rawCommand: `Pair device ${redeemed.device.name}`,
      intent: "HELP",
      targetDeviceId: redeemed.device.id,
      targetDeviceName: redeemed.device.name,
      status: "succeeded",
      detail: `Device paired (${redeemed.device.type}); scoped bearer token issued until ${redeemed.tokenExpiresAt}`,
    });
    broadcastAuditEntry(entry);

    return NextResponse.json({
      device: redeemed.device,
      token: redeemed.token,
      tokenExpiresAt: redeemed.tokenExpiresAt,
    });
  } catch (err) {
    console.error("[ULTRON Pair Redeem]", err);
    return NextResponse.json(
      { error: "Pairing redemption failed." },
      { status: 500 },
    );
  }
}
