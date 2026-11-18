"use client";

import { useState } from "react";
import {
  BatteryCharging,
  Check,
  Copy,
  ExternalLink,
  Laptop,
  Lock,
  Play,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Terminal,
  Trash2,
  Unlock,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type {
  AuditEntry,
  DeviceAction,
  DeviceType,
  PairingChallenge,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

interface DevicesDrawerProps {
  open: boolean;
  onClose: () => void;
  devices: PublicDeviceRecord[];
  auditLogs: AuditEntry[];
  hubUrl: string;
  wsAgentUrl: string;
  wsConnected: boolean;
  onRefresh: () => Promise<void>;
  onExecuteAction: (params: {
    action: DeviceAction;
    targetDeviceIds: string[];
    application?: string;
    confirmed?: boolean;
    rawCommand?: string;
  }) => Promise<void>;
  onFeedback: (message: string, isError?: boolean) => void;
}

type DrawerTab = "devices" | "pair" | "audit";

export default function DevicesDrawer({
  open,
  onClose,
  devices,
  auditLogs,
  hubUrl,
  wsAgentUrl,
  wsConnected,
  onRefresh,
  onExecuteAction,
  onFeedback,
}: DevicesDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>("devices");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [launchAppByDevice, setLaunchAppByDevice] = useState<Record<string, string>>({});
  const [confirmLockId, setConfirmLockId] = useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Pairing state
  const [pairName, setPairName] = useState("");
  const [pairType, setPairType] = useState<DeviceType>("android");
  const [pairAliases, setPairAliases] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [activeChallenge, setActiveChallenge] = useState<{
    challenge: PairingChallenge;
    qrDataUrl: string;
    hubUrl: string;
    wsUrl: string;
  } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open) return null;

  const activeDevices = devices.filter((d) => !d.revokedAt);
  const onlineCount = activeDevices.filter((d) => d.online).length;

  async function handleRenameSubmit(deviceId: string) {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      onFeedback("Device name cannot be empty.", true);
      return;
    }
    setBusyId(deviceId);
    try {
      const res = await fetch(`/api/ultron/devices/${deviceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", name: trimmed }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error || "Rename failed.");
      setEditingId(null);
      await onRefresh();
      onFeedback(`Renamed device to ${trimmed}.`);
    } catch (err) {
      onFeedback(err instanceof Error ? err.message : "Rename failed.", true);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisconnect(device: PublicDeviceRecord) {
    setBusyId(device.id);
    try {
      const res = await fetch(`/api/ultron/devices/${device.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (!res.ok) throw new Error("Failed to disconnect device.");
      await onRefresh();
      onFeedback(`Disconnected ${device.name}.`);
    } catch (err) {
      onFeedback(err instanceof Error ? err.message : "Disconnect failed.", true);
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(device: PublicDeviceRecord) {
    setBusyId(device.id);
    try {
      const res = await fetch(`/api/ultron/devices/${device.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to revoke device token.");
      setConfirmRevokeId(null);
      await onRefresh();
      onFeedback(`Revoked access token for ${device.name}.`);
    } catch (err) {
      onFeedback(err instanceof Error ? err.message : "Revoke failed.", true);
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreatePairing(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = pairName.trim();
    if (!cleanName) {
      setPairError("Enter a device name before generating a pairing code.");
      return;
    }
    setPairingBusy(true);
    setPairError(null);
    try {
      const aliases = pairAliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      const res = await fetch("/api/ultron/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceName: cleanName,
          deviceType: pairType,
          aliases,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        challenge?: PairingChallenge;
        qrDataUrl?: string;
        hubUrl?: string;
        wsUrl?: string;
      };
      if (!res.ok || !data.challenge || !data.qrDataUrl) {
        throw new Error(data.error || "Failed to generate pairing code.");
      }
      setActiveChallenge({
        challenge: data.challenge,
        qrDataUrl: data.qrDataUrl,
        hubUrl: data.hubUrl ?? hubUrl,
        wsUrl: data.wsUrl ?? wsAgentUrl,
      });
      setPairName("");
      setPairAliases("");
      await onRefresh();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : "Pairing setup failed.");
    } finally {
      setPairingBusy(false);
    }
  }

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1800);
    } catch {
      onFeedback("Clipboard unavailable.", true);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        className="devices-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Connected Devices Dashboard"
      >
        <div className="drawer-header">
          <div>
            <h2 className="drawer-title">CONNECTED DEVICES</h2>
            <p className="drawer-subtitle">
              {onlineCount} online · {activeDevices.length} registered · Hub{" "}
              {wsConnected ? "live" : "reconnecting"}
            </p>
          </div>
          <div className="hud-row">
            <button
              type="button"
              className="hud-btn hud-btn-sm"
              onClick={() => void onRefresh()}
              aria-label="Refresh device telemetry"
            >
              <RefreshCw size={14} />
            </button>
            <button
              type="button"
              className="hud-btn hud-btn-sm"
              onClick={onClose}
              aria-label="Close devices dashboard"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="drawer-tabs" role="tablist" aria-label="Device management sections">
          <button
            type="button"
            role="tab"
            className="drawer-tab"
            aria-selected={tab === "devices"}
            onClick={() => setTab("devices")}
          >
            Devices ({activeDevices.length})
          </button>
          <button
            type="button"
            role="tab"
            className="drawer-tab"
            aria-selected={tab === "pair"}
            onClick={() => setTab("pair")}
          >
            Pair Device
          </button>
          <button
            type="button"
            role="tab"
            className="drawer-tab"
            aria-selected={tab === "audit"}
            onClick={() => setTab("audit")}
          >
            Audit Log ({auditLogs.length})
          </button>
        </div>

        <div className="drawer-body">
          {tab === "devices" && (
            <>
              {devices.length === 0 ? (
                <div className="hud-section">
                  <div className="device-name">No paired devices yet</div>
                  <p className="device-meta">
                    Pair your Windows laptop, Android phone, or a live browser companion session
                    using a one-time pairing code or QR scan.
                  </p>
                  <div className="device-actions">
                    <button
                      type="button"
                      className="hud-btn hud-btn-sm"
                      onClick={() => setTab("pair")}
                    >
                      <QrCode size={14} />
                      Pair First Device
                    </button>
                    <a
                      href="/companion"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hud-btn hud-btn-sm"
                    >
                      <ExternalLink size={14} />
                      Open Companion
                    </a>
                  </div>
                </div>
              ) : (
                devices.map((device) => {
                  const isEditing = editingId === device.id;
                  const appInput =
                    launchAppByDevice[device.id] ??
                    device.installedApps[0]?.alias ??
                    "";
                  const isBusy = busyId === device.id;

                  return (
                    <div key={device.id} className="hud-section">
                      <div className="hud-row-between">
                        <div className="hud-row" style={{ alignItems: "center" }}>
                          {device.type === "windows" ? (
                            <Laptop size={16} />
                          ) : device.type === "android" ? (
                            <Smartphone size={16} />
                          ) : (
                            <Terminal size={16} />
                          )}
                          {isEditing ? (
                            <input
                              className="hud-input"
                              style={{ height: 32, width: 190 }}
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              aria-label={`New name for ${device.name}`}
                            />
                          ) : (
                            <span className="device-name">{device.name}</span>
                          )}
                        </div>
                        <span className="device-meta">
                          {device.revokedAt ? (
                            "REVOKED"
                          ) : device.online ? (
                            <span className="hud-row" style={{ alignItems: "center", gap: 4 }}>
                              <Wifi size={12} /> ONLINE
                            </span>
                          ) : (
                            <span className="hud-row" style={{ alignItems: "center", gap: 4 }}>
                              <WifiOff size={12} /> OFFLINE
                            </span>
                          )}
                        </span>
                      </div>

                      <div className="device-meta">
                        {device.type.toUpperCase()}
                        {device.osVersion ? ` (${device.osVersion})` : ""} ·{" "}
                        {device.batteryPercent !== null ? (
                          <>
                            {device.isCharging ? (
                              <BatteryCharging
                                size={12}
                                style={{ display: "inline", verticalAlign: "-2px" }}
                              />
                            ) : null}{" "}
                            {device.batteryPercent}%{device.isCharging ? " charging" : ""}
                          </>
                        ) : (
                          "Battery n/a"
                        )}{" "}
                        · {device.connectionStatus}
                        {device.isLocked ? " · Locked" : ""}
                      </div>

                      <div className="device-meta">
                        Actions:{" "}
                        {device.supportedActions.length > 0
                          ? device.supportedActions
                              .map((a) => a.toLowerCase().replace(/_/g, " "))
                              .join(" · ")
                          : "None"}
                      </div>

                      {device.lastCommand ? (
                        <div className="device-meta">
                          Last: {device.lastCommand.action} ({device.lastCommand.status}) ·{" "}
                          {device.lastCommand.message}
                        </div>
                      ) : null}

                      {!device.revokedAt && (
                        <>
                          <div className="device-divider" />

                          {device.online && (
                            <div className="hud-row" style={{ alignItems: "center" }}>
                              {device.installedApps.length > 0 ? (
                                <select
                                  className="hud-select"
                                  style={{ height: 34 }}
                                  value={appInput}
                                  onChange={(e) =>
                                    setLaunchAppByDevice((prev) => ({
                                      ...prev,
                                      [device.id]: e.target.value,
                                    }))
                                  }
                                  aria-label={`Select application on ${device.name}`}
                                >
                                  {device.installedApps.map((app) => (
                                    <option key={app.alias} value={app.alias}>
                                      {app.displayName}
                                    </option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  className="hud-input"
                                  style={{ height: 34 }}
                                  placeholder="App name (e.g. chrome)"
                                  value={appInput}
                                  onChange={(e) =>
                                    setLaunchAppByDevice((prev) => ({
                                      ...prev,
                                      [device.id]: e.target.value,
                                    }))
                                  }
                                  aria-label={`Application name for ${device.name}`}
                                />
                              )}
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm"
                                disabled={!appInput.trim()}
                                onClick={() =>
                                  void onExecuteAction({
                                    action: "OPEN_APPLICATION",
                                    targetDeviceIds: [device.id],
                                    application: appInput,
                                    rawCommand: `Launch ${appInput} on ${device.name}`,
                                  })
                                }
                              >
                                <Play size={12} />
                                Open
                              </button>
                            </div>
                          )}

                          <div className="device-actions">
                            {isEditing ? (
                              <>
                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  disabled={isBusy}
                                  onClick={() => void handleRenameSubmit(device.id)}
                                >
                                  Save Name
                                </button>
                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  onClick={() => setEditingId(null)}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm"
                                onClick={() => {
                                  setEditingId(device.id);
                                  setRenameValue(device.name);
                                }}
                              >
                                Rename
                              </button>
                            )}

                            {device.online && (
                              <>
                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  onClick={() =>
                                    void onExecuteAction({
                                      action: "CHECK_BATTERY",
                                      targetDeviceIds: [device.id],
                                      rawCommand: `Check battery on ${device.name}`,
                                    })
                                  }
                                >
                                  Sync Status
                                </button>

                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  onClick={() => setConfirmLockId(device.id)}
                                >
                                  <Lock size={12} />
                                  Lock
                                </button>

                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  onClick={() =>
                                    void onExecuteAction({
                                      action: "UNLOCK_REQUEST",
                                      targetDeviceIds: [device.id],
                                      rawCommand: `Unlock request for ${device.name}`,
                                    })
                                  }
                                >
                                  <Unlock size={12} />
                                  Unlock Request
                                </button>

                                <button
                                  type="button"
                                  className="hud-btn hud-btn-sm"
                                  disabled={isBusy}
                                  onClick={() => void handleDisconnect(device)}
                                >
                                  Disconnect
                                </button>
                              </>
                            )}

                            <button
                              type="button"
                              className="hud-btn hud-btn-sm hud-btn-danger"
                              disabled={isBusy}
                              onClick={() => setConfirmRevokeId(device.id)}
                            >
                              <Trash2 size={12} />
                              Revoke
                            </button>
                          </div>

                          {confirmLockId === device.id && (
                            <div className="hud-confirm-row">
                              <span className="device-meta">Confirm lock {device.name}?</span>
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm"
                                onClick={() => {
                                  setConfirmLockId(null);
                                  void onExecuteAction({
                                    action: "LOCK_DEVICE",
                                    targetDeviceIds: [device.id],
                                    confirmed: true,
                                    rawCommand: `Lock ${device.name}`,
                                  });
                                }}
                              >
                                Confirm Lock
                              </button>
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm"
                                onClick={() => setConfirmLockId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}

                          {confirmRevokeId === device.id && (
                            <div className="hud-confirm-row">
                              <span className="hud-error">
                                Revoke token and block {device.name}?
                              </span>
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm hud-btn-danger"
                                onClick={() => void handleRevoke(device)}
                              >
                                Confirm Revoke
                              </button>
                              <button
                                type="button"
                                className="hud-btn hud-btn-sm"
                                onClick={() => setConfirmRevokeId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </>
          )}

          {tab === "pair" && (
            <>
              <form className="hud-section" onSubmit={handleCreatePairing}>
                <div className="device-name">Register New Device</div>
                <p className="device-meta">
                  Issues a 5-minute single-use pairing code and QR payload. Once redeemed, the
                  agent receives a scoped bearer token.
                </p>

                <div>
                  <label htmlFor="pair-device-name" className="hud-label">
                    Device Name
                  </label>
                  <input
                    id="pair-device-name"
                    className="hud-input"
                    placeholder="e.g. Sagar's Phone or Windows Laptop"
                    value={pairName}
                    onChange={(e) => setPairName(e.target.value)}
                  />
                </div>

                <div>
                  <label htmlFor="pair-device-type" className="hud-label">
                    Device Platform
                  </label>
                  <select
                    id="pair-device-type"
                    className="hud-select"
                    value={pairType}
                    onChange={(e) => setPairType(e.target.value as DeviceType)}
                  >
                    <option value="android">Android Companion App (Kotlin)</option>
                    <option value="windows">Windows Automation Agent (Python)</option>
                    <option value="browser">Web Companion Session (/companion)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="pair-device-aliases" className="hud-label">
                    Voice Aliases (optional, comma-separated)
                  </label>
                  <input
                    id="pair-device-aliases"
                    className="hud-input"
                    placeholder="e.g. work laptop, main pc"
                    value={pairAliases}
                    onChange={(e) => setPairAliases(e.target.value)}
                  />
                </div>

                {pairError && <div className="hud-error">{pairError}</div>}

                <div className="device-actions">
                  <button type="submit" className="hud-btn hud-btn-sm" disabled={pairingBusy}>
                    <QrCode size={14} />
                    {pairingBusy ? "Generating..." : "Generate Pairing Code"}
                  </button>
                  <a
                    href="/companion"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hud-btn hud-btn-sm"
                  >
                    <ExternalLink size={14} />
                    Open Web Companion
                  </a>
                </div>
              </form>

              {activeChallenge && (
                <div className="hud-section">
                  <div className="hud-row-between">
                    <span className="device-name">
                      Pairing: {activeChallenge.challenge.deviceName}
                    </span>
                    <span className="device-meta">
                      {activeChallenge.challenge.deviceType.toUpperCase()}
                    </span>
                  </div>

                  <div className="qr-frame">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={activeChallenge.qrDataUrl}
                      alt={`QR pairing code for ${activeChallenge.challenge.deviceName}`}
                      width={200}
                      height={200}
                      referrerPolicy="no-referrer"
                    />
                    <div className="qr-code-text">{activeChallenge.challenge.code}</div>
                    <div className="device-meta">
                      Expires {new Date(activeChallenge.challenge.expiresAt).toLocaleTimeString()}
                    </div>
                  </div>

                  <div className="device-actions">
                    <button
                      type="button"
                      className="hud-btn hud-btn-sm"
                      onClick={() =>
                        void copyText("code", activeChallenge.challenge.code)
                      }
                    >
                      {copiedKey === "code" ? <Check size={12} /> : <Copy size={12} />}
                      Copy Code
                    </button>
                    {activeChallenge.challenge.deviceType === "windows" && (
                      <button
                        type="button"
                        className="hud-btn hud-btn-sm"
                        onClick={() =>
                          void copyText(
                            "win",
                            `python agents/windows/main.py --pair ${activeChallenge.challenge.code} --hub ${activeChallenge.hubUrl}`,
                          )
                        }
                      >
                        {copiedKey === "win" ? <Check size={12} /> : <Copy size={12} />}
                        Copy Windows CLI
                      </button>
                    )}
                    <a
                      href={`/companion?code=${encodeURIComponent(activeChallenge.challenge.code)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hud-btn hud-btn-sm"
                    >
                      <ExternalLink size={12} />
                      Pair in Companion Tab
                    </a>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === "audit" && (
            <>
              {auditLogs.length === 0 ? (
                <div className="hud-section">
                  <div className="device-name">No audit events recorded</div>
                  <p className="device-meta">
                    Every pairing request, voice intent, device dispatch, and token revocation is
                    logged here chronologically.
                  </p>
                </div>
              ) : (
                auditLogs.map((entry) => (
                  <div key={entry.id} className="hud-section">
                    <div className="hud-row-between">
                      <span className="device-name">
                        {entry.intent}
                        {entry.targetDeviceName ? ` · ${entry.targetDeviceName}` : ""}
                      </span>
                      <span className="device-meta">
                        {entry.status.toUpperCase()}
                      </span>
                    </div>
                    <div className="device-meta">
                      {new Date(entry.timestamp).toLocaleTimeString()} · {entry.source} · &ldquo;
                      {entry.rawCommand}&rdquo;
                    </div>
                    <div className="device-meta">
                      {entry.status === "rejected" || entry.status === "failed" ? (
                        <ShieldAlert
                          size={12}
                          style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }}
                        />
                      ) : null}
                      {entry.detail}
                    </div>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
