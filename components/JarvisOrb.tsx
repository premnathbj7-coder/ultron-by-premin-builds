"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  Mic,
  MicOff,
  Send,
  ShieldCheck,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { createOrbScene, type OrbSceneApi } from "@/lib/orbScene";
import { HandTracker, type TrackerStatus } from "@/lib/handTracker";
import DevicesDrawer from "@/components/DevicesDrawer";
import {
  DEFAULT_ENERGY_THEME,
  ENERGY_THEMES,
  ENERGY_THEME_LIST,
  detectThemeCommand,
  getThemeCssVariables,
  loadSavedTheme,
  saveTheme,
  type EnergyThemeId,
} from "@/lib/ultron/themes";
import type {
  AuditEntry,
  CommandIntentType,
  DeviceAction,
  HudSocketEvent,
  PairingChallenge,
  PublicDeviceRecord,
} from "@/lib/ultron/types";

type CameraState = "off" | "starting" | "on" | "error";

const MODE_LABEL: Record<TrackerStatus["mode"], string> = {
  idle: "STANDBY",
  spin: "SPIN",
  zoom: "ZOOM",
};

interface PendingConfirmationState {
  intent: CommandIntentType;
  targetDeviceIds: string[];
  application: string | null;
  summary: string;
  rawCommand: string;
  source: "voice" | "text";
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionInstanceLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export default function JarvisOrb() {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<OrbSceneApi | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);

  const [camera, setCamera] = useState<CameraState>("off");
  const [status, setStatus] = useState<TrackerStatus>({ hands: 0, mode: "idle" });
  const [error, setError] = useState<string | null>(null);

  // Cross-device automation HUD state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [devices, setDevices] = useState<PublicDeviceRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [hubUrl, setHubUrl] = useState("");
  const [wsAgentUrl, setWsAgentUrl] = useState("");
  const [wsConnected, setWsConnected] = useState(false);

  const [commandInput, setCommandInput] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [energyTheme, setEnergyTheme] = useState<EnergyThemeId>(DEFAULT_ENERGY_THEME);
  const [responseBanner, setResponseBanner] = useState<{
    text: string;
    detail?: string;
    isError?: boolean;
  } | null>(null);
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmationState | null>(null);

  const applyThemeCssVars = useCallback((themeId: EnergyThemeId) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.ultronTheme = themeId;
    const vars = getThemeCssVariables(themeId);
    for (const [key, val] of Object.entries(vars)) {
      root.style.setProperty(key, val);
    }
  }, []);

  const applyEnergyTheme = useCallback(
    (
      themeId: EnergyThemeId,
      options: { immediate?: boolean; persist?: boolean } = {},
    ) => {
      setEnergyTheme(themeId);
      applyThemeCssVars(themeId);
      sceneRef.current?.setTheme(themeId, { immediate: options.immediate });
      if (options.persist !== false) {
        saveTheme(themeId);
      }
    },
    [applyThemeCssVars],
  );

  const speakResponse = useCallback(
    (text: string) => {
      if (!speechEnabled || typeof window === "undefined") return;
      if (!("speechSynthesis" in window)) return;
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.02;
        utterance.pitch = 0.92;
        window.speechSynthesis.speak(utterance);
      } catch {
        // Ignore speech synthesis restrictions in headless browsers
      }
    },
    [speechEnabled],
  );

  const fetchDevicesState = useCallback(async () => {
    try {
      const res = await fetch("/api/ultron/devices", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        devices: PublicDeviceRecord[];
        auditLogs: AuditEntry[];
        pairings: PairingChallenge[];
        hubUrl: string;
        wsAgentUrl: string;
      };
      setDevices(data.devices);
      setAuditLogs(data.auditLogs);
      setHubUrl(data.hubUrl);
      setWsAgentUrl(data.wsAgentUrl);
    } catch {
      // Keep UI resilient if transient reload occurs
    }
  }, []);

  // Mount Three.js scene once, restoring saved Energy Core theme immediately
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const savedTheme = loadSavedTheme();
    setEnergyTheme(savedTheme);
    applyThemeCssVars(savedTheme);

    const scene = createOrbScene(container, { initialTheme: savedTheme });
    sceneRef.current = scene;
    return () => {
      trackerRef.current?.stop();
      trackerRef.current = null;
      recognitionRef.current?.stop();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [applyThemeCssVars]);

  // Sync orb animation intensity with voice/command state
  useEffect(() => {
    if (!sceneRef.current) return;
    if (commandBusy) sceneRef.current.setActivityMode("processing");
    else if (listening) sceneRef.current.setActivityMode("listening");
    else if (responseBanner?.isError) sceneRef.current.setActivityMode("alert");
    else sceneRef.current.setActivityMode("idle");
  }, [commandBusy, listening, responseBanner]);

  // Live HUD WebSocket + initial REST hydration
  useEffect(() => {
    void fetchDevicesState();

    let ws: WebSocket | null = null;
    let reconnectTimer = 0;
    let closedByUnmount = false;

    const connectHudSocket = () => {
      if (closedByUnmount || typeof window === "undefined") return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/ws/hud`);

      ws.onopen = () => {
        setWsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as HudSocketEvent;
          if (payload.type === "state:snapshot") {
            setDevices(payload.devices);
            setAuditLogs(payload.auditLogs);
          } else if (payload.type === "device:updated") {
            setDevices((prev) => {
              const idx = prev.findIndex((d) => d.id === payload.device.id);
              if (idx === -1) return [...prev, payload.device];
              const next = [...prev];
              next[idx] = payload.device;
              return next;
            });
          } else if (payload.type === "audit:appended") {
            setAuditLogs((prev) => [payload.entry, ...prev].slice(0, 60));
          }
        } catch {
          // Ignore malformed frame
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!closedByUnmount) {
          reconnectTimer = window.setTimeout(connectHudSocket, 2500);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const initTimer = window.setTimeout(connectHudSocket, 10);
    return () => {
      closedByUnmount = true;
      window.clearTimeout(initTimer);
      window.clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [fetchDevicesState]);

  const stopGestures = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    setCamera("off");
    setStatus({ hands: 0, mode: "idle" });
  }, []);

  const startGestures = useCallback(async () => {
    const video = videoRef.current;
    const overlay = overlayRef.current;
    if (!video || !overlay || trackerRef.current) return;

    setCamera("starting");
    setError(null);

    const tracker = new HandTracker(video, overlay, {
      onRotate: (dt, dp) => sceneRef.current?.rotateBy(dt, dp),
      onZoom: (factor) => sceneRef.current?.zoomBy(factor),
      onStatus: setStatus,
    });
    trackerRef.current = tracker;

    try {
      await tracker.start();
      setCamera("on");
    } catch (err) {
      trackerRef.current = null;
      tracker.stop();
      setCamera("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "CAMERA ACCESS DENIED"
          : "TRACKING INIT FAILED",
      );
    }
  }, []);

  const toggleGestures = useCallback(() => {
    if (trackerRef.current) stopGestures();
    else void startGestures();
  }, [startGestures, stopGestures]);

  const submitCommand = useCallback(
    async (text: string, source: "voice" | "text" = "text") => {
      const clean = text.trim();
      if (!clean) return;
      setCommandBusy(true);
      setPendingConfirmation(null);

      try {
        const res = await fetch("/api/ultron/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean, source }),
        });
        const data = (await res.json()) as {
          error?: string;
          status?: string;
          theme?: EnergyThemeId | null;
          spokenResponse?: string;
          parsedIntent?: {
            intent: CommandIntentType;
            targetDevice: string | null;
            application: string | null;
            theme?: EnergyThemeId | null;
          };
          pendingConfirmation?: {
            intent: CommandIntentType;
            targetDeviceIds: string[];
            application: string | null;
            summary: string;
          };
        };

        if (!res.ok) {
          const msg = data.error || "Command routing failed.";
          setResponseBanner({ text: msg, isError: true });
          speakResponse(msg);
          return;
        }

        const resolvedTheme = data.theme ?? data.parsedIntent?.theme ?? null;
        if (data.parsedIntent?.intent === "SET_THEME" && resolvedTheme) {
          applyEnergyTheme(resolvedTheme);
        }

        const spoken = data.spokenResponse || "Command processed.";
        const intentMeta = data.parsedIntent
          ? `${data.parsedIntent.intent}${
              resolvedTheme
                ? ` · ${ENERGY_THEMES[resolvedTheme].name}`
                : data.parsedIntent.targetDevice
                  ? ` · ${data.parsedIntent.targetDevice}`
                  : ""
            }${data.parsedIntent.application ? ` · ${data.parsedIntent.application}` : ""}`
          : undefined;

        setResponseBanner({
          text: spoken,
          detail: intentMeta,
          isError: data.status === "error" || data.status === "partial_or_failed",
        });

        if (data.status === "confirmation_required" && data.pendingConfirmation) {
          setPendingConfirmation({
            ...data.pendingConfirmation,
            rawCommand: clean,
            source,
          });
        }

        speakResponse(spoken);
        await fetchDevicesState();
      } catch {
        const localTheme = detectThemeCommand(clean);
        if (localTheme) {
          applyEnergyTheme(localTheme.theme);
          setResponseBanner({
            text: localTheme.spokenResponse,
            detail: `SET_THEME · ${ENERGY_THEMES[localTheme.theme].name}`,
          });
          speakResponse(localTheme.spokenResponse);
          return;
        }
        setResponseBanner({
          text: "Unable to reach ULTRON hub.",
          isError: true,
        });
      } finally {
        setCommandBusy(false);
      }
    },
    [applyEnergyTheme, fetchDevicesState, speakResponse],
  );

  const executeDirectAction = useCallback(
    async (params: {
      action: DeviceAction;
      targetDeviceIds: string[];
      application?: string;
      confirmed?: boolean;
      rawCommand?: string;
      source?: "voice" | "text" | "ui";
    }) => {
      setCommandBusy(true);
      try {
        const res = await fetch("/api/ultron/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: params.action,
            targetDeviceIds: params.targetDeviceIds,
            application: params.application ?? null,
            confirmed: Boolean(params.confirmed),
            source: params.source ?? "ui",
            rawCommand: params.rawCommand,
          }),
        });
        const data = (await res.json()) as {
          error?: string;
          status?: string;
          spokenResponse?: string;
        };
        if (!res.ok) {
          const msg = data.error || "Action execution failed.";
          setResponseBanner({ text: msg, isError: true });
          speakResponse(msg);
          return;
        }
        const msg = data.spokenResponse || "Action completed.";
        setResponseBanner({
          text: msg,
          detail: params.action,
          isError: data.status !== "succeeded",
        });
        speakResponse(msg);
        await fetchDevicesState();
      } catch {
        setResponseBanner({
          text: "Failed to dispatch device action.",
          isError: true,
        });
      } finally {
        setCommandBusy(false);
      }
    },
    [fetchDevicesState, speakResponse],
  );

  const toggleVoice = useCallback(() => {
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    const SpeechCtor =
      typeof window !== "undefined"
        ? ((
            window as unknown as {
              SpeechRecognition?: new () => SpeechRecognitionInstanceLike;
              webkitSpeechRecognition?: new () => SpeechRecognitionInstanceLike;
            }
          ).SpeechRecognition ??
          (
            window as unknown as {
              webkitSpeechRecognition?: new () => SpeechRecognitionInstanceLike;
            }
          ).webkitSpeechRecognition)
        : undefined;

    if (!SpeechCtor) {
      setResponseBanner({
        text: "Browser speech recognition is unavailable here. Type your command in the bar below.",
        isError: true,
      });
      return;
    }

    try {
      const recognition = new SpeechCtor();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event) => {
        let transcript = "";
        let isFinal = false;
        for (let i = 0; i < event.results.length; i++) {
          const res = event.results[i];
          transcript += res[0]?.transcript ?? "";
          if (res.isFinal) isFinal = true;
        }
        setCommandInput(transcript);
        if (isFinal && transcript.trim()) {
          setListening(false);
          void submitCommand(transcript, "voice");
        }
      };

      recognition.onerror = (ev) => {
        setListening(false);
        setResponseBanner({
          text:
            ev.error === "not-allowed"
              ? "Microphone permission denied. Type a command or allow microphone access."
              : `Voice recognition error: ${ev.error}`,
          isError: true,
        });
      };

      recognition.onend = () => {
        setListening(false);
      };

      recognitionRef.current = recognition;
      setListening(true);
      recognition.start();
    } catch {
      setListening(false);
      setResponseBanner({
        text: "Could not start voice listener.",
        isError: true,
      });
    }
  }, [listening, submitCommand]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      switch (e.key) {
        case "+":
        case "=":
          sceneRef.current?.zoomIn();
          break;
        case "-":
        case "_":
          sceneRef.current?.zoomOut();
          break;
        case "r":
        case "R":
          sceneRef.current?.resetView();
          break;
        case "g":
        case "G":
          toggleGestures();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleGestures]);

  const cameraOn = camera === "on";
  const activeDevices = devices.filter((d) => !d.revokedAt);
  const onlineCount = activeDevices.filter((d) => d.online).length;

  return (
    <>
      <div ref={containerRef} className="orb-root" data-testid="ultron-orb-canvas" />

      <div className="overlay-vignette" />
      <div className="overlay-grain" />
      <div className="overlay-scanlines" />

      <div className="hud hud-title">U.L.T.R.O.N.</div>

      <section
        className="hud hud-theme-panel"
        aria-label="Energy Core Theme"
        data-testid="energy-core-theme-panel"
      >
        <div className="hud-theme-header">ENERGY CORE THEME</div>
        <div className="hud-theme-list" role="group" aria-label="Energy Core Theme options">
          {ENERGY_THEME_LIST.map((themeOption) => {
            const isSelected = energyTheme === themeOption.id;
            return (
              <button
                key={themeOption.id}
                type="button"
                className="hud-theme-btn"
                aria-pressed={isSelected}
                data-theme-id={themeOption.id}
                onClick={() => applyEnergyTheme(themeOption.id)}
              >
                <span
                  className="hud-theme-dot"
                  aria-hidden="true"
                  style={{
                    backgroundColor: themeOption.energyCore,
                    boxShadow: `0 0 8px ${themeOption.primary}`,
                  }}
                />
                <span>{themeOption.name}</span>
              </button>
            );
          })}
        </div>
      </section>

      <div className="hud hud-top-right">
        <button
          type="button"
          className="hud-btn"
          aria-pressed={drawerOpen}
          onClick={() => setDrawerOpen((v) => !v)}
        >
          <Cpu size={14} />
          DEVICES · {onlineCount}/{activeDevices.length}
        </button>
        <button
          type="button"
          className="hud-btn"
          aria-pressed={listening}
          onClick={toggleVoice}
        >
          {listening ? <Mic size={14} /> : <MicOff size={14} />}
          {listening ? "LISTENING" : "VOICE"}
        </button>
        <button
          type="button"
          className="hud-btn"
          aria-pressed={speechEnabled}
          onClick={() => setSpeechEnabled((v) => !v)}
          aria-label={speechEnabled ? "Mute spoken responses" : "Enable spoken responses"}
        >
          {speechEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      </div>

      <div className="hud hud-hint">
        <div>
          <span className="key">DRAG</span> spin&nbsp;&nbsp;
          <span className="key">SCROLL</span> zoom
        </div>
        {cameraOn ? (
          <div>
            <span className="key">PINCH + MOVE</span> spin&nbsp;&nbsp;
            <span className="key">PINCH BOTH HANDS ± SPREAD</span> zoom
          </div>
        ) : (
          <div>
            <span className="key">G</span> hand gestures&nbsp;&nbsp;
            <span className="key">R</span> reset&nbsp;&nbsp;
            <span className="key">+/−</span> zoom
          </div>
        )}
      </div>

      {/* Command Bar & Grounded Response Banner */}
      <div className="hud hud-command-dock">
        {responseBanner && (
          <div
            className={`hud-response-banner${responseBanner.isError ? " is-error" : ""}`}
            role="status"
          >
            <div className="hud-response-top">
              <div>
                <div>{responseBanner.text}</div>
                {responseBanner.detail && (
                  <div className="hud-response-meta">{responseBanner.detail}</div>
                )}
              </div>
              <button
                type="button"
                className="hud-btn hud-btn-sm"
                onClick={() => {
                  setResponseBanner(null);
                  setPendingConfirmation(null);
                }}
                aria-label="Dismiss ULTRON response"
              >
                <X size={12} />
              </button>
            </div>

            {pendingConfirmation && (
              <div className="hud-confirm-row">
                <button
                  type="button"
                  className="hud-btn hud-btn-sm"
                  disabled={commandBusy}
                  onClick={() => {
                    const pending = pendingConfirmation;
                    setPendingConfirmation(null);
                    void executeDirectAction({
                      action: pending.intent as DeviceAction,
                      targetDeviceIds: pending.targetDeviceIds,
                      application: pending.application ?? undefined,
                      confirmed: true,
                      source: pending.source,
                      rawCommand: pending.rawCommand,
                    });
                  }}
                >
                  <ShieldCheck size={13} />
                  Confirm Action
                </button>
                <button
                  type="button"
                  className="hud-btn hud-btn-sm"
                  onClick={() => {
                    setPendingConfirmation(null);
                    setResponseBanner({ text: "Action cancelled." });
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}

        <form
          className="hud-command-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!commandInput.trim() || commandBusy) return;
            const text = commandInput;
            setCommandInput("");
            void submitCommand(text, "text");
          }}
        >
          <input
            type="text"
            className="hud-command-input"
            value={commandInput}
            onChange={(e) => setCommandInput(e.target.value)}
            placeholder='Ask ULTRON (e.g. "Open WhatsApp on my phone")'
            aria-label="ULTRON voice or text command"
          />
          <button
            type="submit"
            className="hud-btn hud-btn-sm"
            disabled={commandBusy || !commandInput.trim()}
            aria-label="Send command to ULTRON"
          >
            <Send size={13} />
            {commandBusy ? "ROUTING" : "SEND"}
          </button>
        </form>
      </div>

      <div className="hud hud-controls">
        <div className={`camera-panel${cameraOn ? " visible" : ""}`}>
          <video ref={videoRef} muted playsInline className="camera-video" />
          <canvas ref={overlayRef} width={208} height={156} className="camera-overlay" />
          <div className="camera-status">
            {status.hands > 0
              ? `${status.hands} HAND${status.hands > 1 ? "S" : ""} · ${MODE_LABEL[status.mode]}`
              : "SHOW HANDS"}
          </div>
        </div>

        {error && <div className="hud-error">{error}</div>}

        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            aria-pressed={cameraOn}
            onClick={toggleGestures}
            disabled={camera === "starting"}
          >
            {camera === "starting" ? "INITIALIZING…" : cameraOn ? "GESTURES ON" : "GESTURES OFF"}
          </button>
        </div>
        <div className="hud-row">
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.zoomIn()}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.zoomOut()}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className="hud-btn"
            onClick={() => sceneRef.current?.resetView()}
          >
            RESET
          </button>
        </div>
      </div>

      <DevicesDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        devices={devices}
        auditLogs={auditLogs}
        hubUrl={hubUrl}
        wsAgentUrl={wsAgentUrl}
        wsConnected={wsConnected}
        onRefresh={fetchDevicesState}
        onExecuteAction={executeDirectAction}
        onFeedback={(msg, isErr) => {
          setResponseBanner({ text: msg, isError: isErr });
        }}
      />
    </>
  );
}
