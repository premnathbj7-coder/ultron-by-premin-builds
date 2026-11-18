"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  BatteryCharging,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Unlock,
  Wifi,
  WifiOff,
} from "lucide-react";
import type {
  AgentCommandPayload,
  DeviceAction,
  InstalledApp,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

interface StoredCompanionSession {
  deviceId: string;
  deviceName: string;
  deviceType: "android" | "windows" | "browser";
  token: string;
}

const STORAGE_KEY = "ultron_companion_session_v1";

const DEFAULT_ANDROID_APPS: InstalledApp[] = [
  { alias: "whatsapp", identifier: "com.whatsapp", displayName: "WhatsApp" },
  { alias: "youtube", identifier: "com.google.android.youtube", displayName: "YouTube" },
  { alias: "instagram", identifier: "com.instagram.android", displayName: "Instagram" },
  { alias: "spotify", identifier: "com.spotify.music", displayName: "Spotify" },
  { alias: "chrome", identifier: "com.android.chrome", displayName: "Google Chrome" },
];

export default function CompanionAgent({ initialCode = "" }: { initialCode?: string }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [session, setSession] = useState<StoredCompanionSession | null>(null);
  const [pairingCode, setPairingCode] = useState(initialCode);
  const [deviceNameInput, setDeviceNameInput] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);

  const [wsState, setWsState] = useState<"disconnected" | "connecting" | "connected" | "revoked">(
    "disconnected",
  );
  const [batteryPercent, setBatteryPercent] = useState(84);
  const [isCharging, setIsCharging] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const [installedApps] = useState<InstalledApp[]>(DEFAULT_ANDROID_APPS);
  const [activeAppBanner, setActiveAppBanner] = useState<string | null>(null);
  const [unlockPromptPending, setUnlockPromptPending] = useState(false);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const batteryRef = useRef(batteryPercent);
  const chargingRef = useRef(isCharging);
  const lockedRef = useRef(isLocked);
  const appsRef = useRef(installedApps);

  useEffect(() => {
    batteryRef.current = batteryPercent;
    chargingRef.current = isCharging;
    lockedRef.current = isLocked;
    appsRef.current = installedApps;
  }, [batteryPercent, isCharging, isLocked, installedApps]);

  const appendEvent = useCallback((line: string) => {
    setEventLog((prev) =>
      [`${new Date().toLocaleTimeString()} · ${line}`, ...prev].slice(0, 25),
    );
  }, []);

  // Load saved companion session on mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredCompanionSession;
        if (parsed.token && parsed.deviceId) {
          setSession(parsed);
        }
      }
    } catch {
      // Ignore invalid local storage
    }
  }, []);

  // Push telemetry changes over active WebSocket
  const sendTelemetry = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "agent:telemetry",
        batteryPercent: batteryRef.current,
        isCharging: chargingRef.current,
        isLocked: lockedRef.current,
        installedApps: appsRef.current,
      }),
    );
  }, []);

  useEffect(() => {
    sendTelemetry();
  }, [batteryPercent, isCharging, isLocked, sendTelemetry]);

  // Maintain authenticated WebSocket connection when paired
  useEffect(() => {
    if (!session) return;
    let closedByCleanup = false;
    let heartbeatId = 0;
    let reconnectId = 0;

    const connect = () => {
      if (closedByCleanup) return;
      setWsState("connecting");
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${proto}//${window.location.host}/ws/agent?token=${encodeURIComponent(session.token)}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        setWsState("connected");
        appendEvent(`Authenticated WebSocket established as ${session.deviceName}`);
        const supportedActions: DeviceAction[] = [
          "OPEN_APPLICATION",
          "LOCK_DEVICE",
          "UNLOCK_REQUEST",
          "CHECK_BATTERY",
          "PING",
        ];
        ws.send(
          JSON.stringify({
            type: "agent:hello",
            osVersion: navigator.platform || "Web Companion",
            batteryPercent: batteryRef.current,
            isCharging: chargingRef.current,
            isLocked: lockedRef.current,
            supportedActions,
            installedApps: appsRef.current,
          }),
        );

        heartbeatId = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "agent:heartbeat",
                batteryPercent: batteryRef.current,
                isCharging: chargingRef.current,
                isLocked: lockedRef.current,
              }),
            );
          }
        }, 15_000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
          } & Partial<AgentCommandPayload>;
          if (msg.type !== "hub:command" || !msg.commandId || !msg.action) return;

          const { commandId, action, application } = msg;
          appendEvent(`Received ${action}${application ? ` (${application})` : ""}`);

          if (action === "PING") {
            ws.send(
              JSON.stringify({
                type: "agent:command_result",
                commandId,
                success: true,
                batteryPercent: batteryRef.current,
                isCharging: chargingRef.current,
                isLocked: lockedRef.current,
                message: `${session.deviceName} responded to ping (${batteryRef.current}% battery).`,
              }),
            );
            return;
          }

          if (action === "CHECK_BATTERY") {
            ws.send(
              JSON.stringify({
                type: "agent:command_result",
                commandId,
                success: true,
                batteryPercent: batteryRef.current,
                isCharging: chargingRef.current,
                message: `${session.deviceName} battery is ${batteryRef.current}%${
                  chargingRef.current ? " and charging" : ""
                }.`,
              }),
            );
            return;
          }

          if (action === "LOCK_DEVICE") {
            lockedRef.current = true;
            setIsLocked(true);
            setUnlockPromptPending(false);
            ws.send(
              JSON.stringify({
                type: "agent:command_result",
                commandId,
                success: true,
                isLocked: true,
                message: `${session.deviceName} has been locked.`,
              }),
            );
            return;
          }

          if (action === "UNLOCK_REQUEST") {
            if (!lockedRef.current) {
              ws.send(
                JSON.stringify({
                  type: "agent:command_result",
                  commandId,
                  success: true,
                  isLocked: false,
                  message: `${session.deviceName} is already unlocked.`,
                }),
              );
              return;
            }
            setUnlockPromptPending(true);
            ws.send(
              JSON.stringify({
                type: "agent:command_result",
                commandId,
                success: true,
                isLocked: true,
                message: `Unlock requested. Please authenticate on ${session.deviceName} to unlock it.`,
              }),
            );
            return;
          }

          if (action === "OPEN_APPLICATION") {
            const targetAlias = (application ?? "").trim().toLowerCase();
            const found = appsRef.current.find(
              (a) =>
                a.alias.toLowerCase() === targetAlias ||
                a.displayName.toLowerCase() === targetAlias,
            );
            if (!found) {
              ws.send(
                JSON.stringify({
                  type: "agent:command_result",
                  commandId,
                  success: false,
                  errorCode: "APP_NOT_INSTALLED",
                  message: `${application || "Application"} is not installed on ${session.deviceName}.`,
                }),
              );
              return;
            }
            if (lockedRef.current) {
              ws.send(
                JSON.stringify({
                  type: "agent:command_result",
                  commandId,
                  success: false,
                  errorCode: "DEVICE_LOCKED",
                  message: `${session.deviceName} is locked; notification queued to open ${found.displayName} after authentication.`,
                }),
              );
              return;
            }

            setActiveAppBanner(`Active App: ${found.displayName} (${found.identifier})`);
            ws.send(
              JSON.stringify({
                type: "agent:command_result",
                commandId,
                success: true,
                message: `Opened ${found.displayName} on ${session.deviceName}.`,
              }),
            );
          }
        } catch {
          // Ignore invalid JSON
        }
      };

      ws.onclose = (ev) => {
        window.clearInterval(heartbeatId);
        wsRef.current = null;
        if (ev.code === 4003 || ev.code === 4001) {
          setWsState("revoked");
          appendEvent("Device token was revoked or expired.");
          window.localStorage.removeItem(STORAGE_KEY);
          setSession(null);
          return;
        }
        setWsState("disconnected");
        if (!closedByCleanup) {
          reconnectId = window.setTimeout(connect, 2500);
        }
      };
    };

    connect();
    return () => {
      closedByCleanup = true;
      window.clearInterval(heartbeatId);
      window.clearTimeout(reconnectId);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [session, appendEvent]);

  async function handlePairSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = pairingCode.trim().toUpperCase();
    if (!code) {
      setPairError("Enter the 6-character pairing code from ULTRON Devices.");
      return;
    }

    setPairingBusy(true);
    setPairError(null);
    try {
      const res = await fetch("/api/ultron/pair/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          deviceName: deviceNameInput.trim() || undefined,
          osVersion: "Web Companion Agent",
          installedApps,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        device?: PublicDeviceRecord;
        token?: string;
      };
      if (!res.ok || !data.device || !data.token) {
        throw new Error(data.error || "Pairing failed.");
      }

      const nextSession: StoredCompanionSession = {
        deviceId: data.device.id,
        deviceName: data.device.name,
        deviceType: data.device.type,
        token: data.token,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
      setWsState("connecting");
    } catch (err) {
      setPairError(err instanceof Error ? err.message : "Pairing failed.");
    } finally {
      setPairingBusy(false);
    }
  }

  function handleForgetSession() {
    wsRef.current?.close();
    window.localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setWsState("disconnected");
    setActiveAppBanner(null);
    setUnlockPromptPending(false);
  }

  return (
    <main className="companion-page">
      <div className="companion-shell">
        <div className="hud-row-between">
          <div>
            <h1 className="drawer-title">ULTRON DEVICE AGENT · WEB COMPANION</h1>
            <p className="drawer-subtitle">
              Real WebSocket client speaking the same pairing and command protocol as the Android
              and Windows agents.
            </p>
          </div>
          <Link href="/" className="hud-btn hud-btn-sm">
            <ArrowLeft size={14} />
            Back to Orb
          </Link>
        </div>

        {!session ? (
          <form className="hud-section" onSubmit={handlePairSubmit}>
            <div className="device-name">Pair This Device</div>
            <p className="device-meta">
              Generate a 6-character pairing code in the ULTRON Devices drawer and redeem it here to
              establish a live authenticated WebSocket session.
            </p>
            <div>
              <label htmlFor="companion-code" className="hud-label">
                One-Time Pairing Code
              </label>
              <input
                id="companion-code"
                className="hud-input"
                placeholder="e.g. AB23CD"
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
              />
            </div>
            <div>
              <label htmlFor="companion-name" className="hud-label">
                Override Device Name (optional)
              </label>
              <input
                id="companion-name"
                className="hud-input"
                placeholder="Leave blank to keep hub name"
                value={deviceNameInput}
                onChange={(e) => setDeviceNameInput(e.target.value)}
              />
            </div>
            {pairError && <div className="hud-error">{pairError}</div>}
            {wsState === "revoked" && (
              <div className="hud-error">
                <ShieldAlert size={13} style={{ display: "inline", marginRight: 6 }} />
                Previous device token was revoked by ULTRON Hub. Pair again to reconnect.
              </div>
            )}
            <div className="device-actions">
              <button type="submit" className="hud-btn hud-btn-sm" disabled={pairingBusy}>
                <ShieldCheck size={14} />
                {pairingBusy ? "Pairing..." : "Pair & Connect"}
              </button>
            </div>
          </form>
        ) : (
          <div className="companion-grid">
            <section className="hud-section">
              <div className="hud-row-between">
                <div className="hud-row" style={{ alignItems: "center" }}>
                  <Smartphone size={16} />
                  <span className="device-name">{session.deviceName}</span>
                </div>
                <span className="device-meta">
                  {wsState === "connected" ? (
                    <span className="hud-row" style={{ alignItems: "center", gap: 4 }}>
                      <Wifi size={12} /> CONNECTED
                    </span>
                  ) : (
                    <span className="hud-row" style={{ alignItems: "center", gap: 4 }}>
                      <WifiOff size={12} /> {wsState.toUpperCase()}
                    </span>
                  )}
                </span>
              </div>

              <div className="device-meta">
                Type: {session.deviceType.toUpperCase()} · State:{" "}
                {isLocked ? "LOCKED" : "UNLOCKED"} · Battery: {batteryPercent}%
                {isCharging ? " (Charging)" : ""}
              </div>

              {activeAppBanner && (
                <div className="hud-response-banner">
                  <div>{activeAppBanner}</div>
                </div>
              )}

              {unlockPromptPending && (
                <div className="hud-response-banner">
                  <div>
                    ULTRON requested unlock. Normal user authentication is required on this device.
                  </div>
                  <div className="device-actions">
                    <button
                      type="button"
                      className="hud-btn hud-btn-sm"
                      onClick={() => {
                        setIsLocked(false);
                        setUnlockPromptPending(false);
                        appendEvent("User authenticated locally to unlock device.");
                      }}
                    >
                      <Unlock size={13} />
                      Authenticate & Unlock
                    </button>
                  </div>
                </div>
              )}

              <div className="device-divider" />

              <div>
                <label htmlFor="battery-range" className="hud-label">
                  Battery Level ({batteryPercent}%)
                </label>
                <input
                  id="battery-range"
                  type="range"
                  min={1}
                  max={100}
                  value={batteryPercent}
                  onChange={(e) => setBatteryPercent(Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              </div>

              <div className="device-actions">
                <button
                  type="button"
                  className="hud-btn hud-btn-sm"
                  aria-pressed={isCharging}
                  onClick={() => setIsCharging((v) => !v)}
                >
                  <BatteryCharging size={13} />
                  {isCharging ? "Charging On" : "On Battery"}
                </button>
                <button
                  type="button"
                  className="hud-btn hud-btn-sm"
                  aria-pressed={isLocked}
                  onClick={() => {
                    setIsLocked((v) => !v);
                    setUnlockPromptPending(false);
                  }}
                >
                  {isLocked ? <Lock size={13} /> : <Unlock size={13} />}
                  {isLocked ? "Locked" : "Unlocked"}
                </button>
                <button
                  type="button"
                  className="hud-btn hud-btn-sm hud-btn-danger"
                  onClick={handleForgetSession}
                >
                  Unpair Local Session
                </button>
              </div>
            </section>

            <section className="hud-section">
              <div className="device-name">Installed Apps & Event Stream</div>
              <div className="device-meta">
                Registered apps: {installedApps.map((a) => a.displayName).join(" · ")}
              </div>
              <div className="device-divider" />
              {eventLog.length === 0 ? (
                <div className="device-meta">Waiting for commands from ULTRON Hub…</div>
              ) : (
                eventLog.map((line, idx) => (
                  <div key={idx} className="device-meta">
                    {line}
                  </div>
                ))
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
