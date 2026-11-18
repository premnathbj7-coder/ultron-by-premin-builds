import { NextRequest, NextResponse } from "next/server";
import {
  listActivePairings,
  listAuditLogs,
  listPublicDevices,
} from "@/lib/server/store";

function resolveHubOrigin(req: NextRequest): { hubUrl: string; wsAgentUrl: string } {
  const configured = process.env.ULTRON_PUBLIC_URL?.trim();
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || (req.nextUrl.protocol.replace(":", "") || "http");
  const hubUrl = configured ? configured.replace(/\/$/, "") : `${proto}://${host}`;
  const wsProto = hubUrl.startsWith("https://") ? "wss://" : "ws://";
  const wsHost = hubUrl.replace(/^https?:\/\//, "");
  return {
    hubUrl,
    wsAgentUrl: `${wsProto}${wsHost}/ws/agent`,
  };
}

export async function GET(req: NextRequest) {
  const { hubUrl, wsAgentUrl } = resolveHubOrigin(req);
  return NextResponse.json({
    devices: listPublicDevices(),
    auditLogs: listAuditLogs(60),
    pairings: listActivePairings(),
    hubUrl,
    wsAgentUrl,
  });
}
