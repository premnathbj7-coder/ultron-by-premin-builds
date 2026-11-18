import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import {
  appendAuditLog,
  createPairingChallenge,
} from "@/lib/server/store";
import { broadcastAuditEntry } from "@/lib/server/wsHub";
import type { DeviceType } from "@/lib/ultron/types";

function resolveHubOrigin(req: NextRequest): { hubUrl: string; wsUrl: string } {
  const configured = process.env.ULTRON_PUBLIC_URL?.trim();
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || (req.nextUrl.protocol.replace(":", "") || "http");
  const hubUrl = configured ? configured.replace(/\/$/, "") : `${proto}://${host}`;
  const wsProto = hubUrl.startsWith("https://") ? "wss://" : "ws://";
  const wsHost = hubUrl.replace(/^https?:\/\//, "");
  return { hubUrl, wsUrl: `${wsProto}${wsHost}/ws/agent` };
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      deviceName?: string;
      deviceType?: DeviceType;
      aliases?: string[];
    };

    const deviceType: DeviceType =
      body.deviceType === "windows" ||
      body.deviceType === "android" ||
      body.deviceType === "browser"
        ? body.deviceType
        : "android";

    const deviceName = (body.deviceName ?? "").trim();
    if (!deviceName) {
      return NextResponse.json(
        { error: "Device name is required." },
        { status: 400 },
      );
    }

    const { hubUrl, wsUrl } = resolveHubOrigin(req);
    const challenge = createPairingChallenge({
      deviceName,
      deviceType,
      customAliases: Array.isArray(body.aliases) ? body.aliases : undefined,
      hubUrl,
      wsUrl,
    });

    const qrDataUrl = await QRCode.toDataURL(challenge.qrPayload, {
      width: 220,
      margin: 2,
      color: {
        dark: "#ffcc66",
        light: "#0a0500",
      },
    });

    const entry = appendAuditLog({
      source: "ui",
      rawCommand: `Generate pairing code for ${deviceName} (${deviceType})`,
      intent: "HELP",
      targetDeviceId: null,
      targetDeviceName: deviceName,
      status: "succeeded",
      detail: `Issued one-time pairing code expiring ${challenge.expiresAt}`,
    });
    broadcastAuditEntry(entry);

    return NextResponse.json({
      challenge,
      qrDataUrl,
      hubUrl,
      wsUrl,
    });
  } catch (err) {
    console.error("[ULTRON Pair POST]", err);
    return NextResponse.json(
      { error: "Failed to generate pairing challenge." },
      { status: 500 },
    );
  }
}
