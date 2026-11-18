import { NextRequest, NextResponse } from "next/server";
import {
  appendAuditLog,
  getPublicDevice,
  renameDevice,
} from "@/lib/server/store";
import {
  broadcastAuditEntry,
  broadcastHud,
  disconnectAgentSocket,
  revokeAndDisconnectDevice,
} from "@/lib/server/wsHub";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const existing = getPublicDevice(id);
  if (!existing) {
    return NextResponse.json({ error: "Device not found." }, { status: 404 });
  }

  try {
    const body = (await req.json()) as {
      action?: "rename" | "disconnect";
      name?: string;
      aliases?: string[];
    };

    if (body.action === "disconnect") {
      disconnectAgentSocket(id, "DISCONNECTED_FROM_DASHBOARD");
      const updated = getPublicDevice(id);
      const entry = appendAuditLog({
        source: "ui",
        rawCommand: `Disconnect ${existing.name}`,
        intent: "HELP",
        targetDeviceId: id,
        targetDeviceName: existing.name,
        status: "succeeded",
        detail: "Active WebSocket session closed by operator.",
      });
      broadcastAuditEntry(entry);
      return NextResponse.json({ device: updated });
    }

    const newName = (body.name ?? "").trim();
    if (!newName) {
      return NextResponse.json(
        { error: "Device name cannot be empty." },
        { status: 400 },
      );
    }

    const updated = renameDevice(id, newName, body.aliases);
    if (!updated) {
      return NextResponse.json({ error: "Rename failed." }, { status: 400 });
    }
    broadcastHud({ type: "device:updated", device: updated });

    const entry = appendAuditLog({
      source: "ui",
      rawCommand: `Rename ${existing.name} -> ${updated.name}`,
      intent: "HELP",
      targetDeviceId: id,
      targetDeviceName: updated.name,
      status: "succeeded",
      detail: `Device renamed; aliases: ${updated.aliases.join(", ")}`,
    });
    broadcastAuditEntry(entry);

    return NextResponse.json({ device: updated });
  } catch (err) {
    console.error("[ULTRON Device PATCH]", err);
    return NextResponse.json(
      { error: "Failed to update device." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const existing = getPublicDevice(id);
  if (!existing) {
    return NextResponse.json({ error: "Device not found." }, { status: 404 });
  }

  const revoked = revokeAndDisconnectDevice(id);
  const entry = appendAuditLog({
    source: "ui",
    rawCommand: `Revoke access for ${existing.name}`,
    intent: "HELP",
    targetDeviceId: id,
    targetDeviceName: existing.name,
    status: "succeeded",
    detail: "Device token revoked and active WebSocket terminated.",
  });
  broadcastAuditEntry(entry);

  return NextResponse.json({ device: revoked });
}
