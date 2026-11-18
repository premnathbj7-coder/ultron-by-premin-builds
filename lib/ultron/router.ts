import { ENERGY_THEMES, normalizeThemeId } from "./themes";
import type {
  DeviceAction,
  InstalledApp,
  ParsedCommandIntent,
  PublicDeviceRecord,
} from "./types";

const APP_ALIAS_MAP: Record<string, string> = {
  "visual studio code": "vscode",
  "vs code": "vscode",
  vscode: "vscode",
  code: "vscode",
  "google chrome": "chrome",
  chrome: "chrome",
  browser: "chrome",
  whatsapp: "whatsapp",
  "whats app": "whatsapp",
  youtube: "youtube",
  "you tube": "youtube",
  instagram: "instagram",
  insta: "instagram",
  spotify: "spotify",
  notepad: "notepad",
  calculator: "calculator",
  calc: "calculator",
  terminal: "terminal",
  "windows terminal": "terminal",
  powershell: "terminal",
  cmd: "terminal",
  explorer: "explorer",
  "file explorer": "explorer",
  files: "files",
  edge: "edge",
  "microsoft edge": "edge",
  settings: "settings",
  camera: "camera",
  gmail: "gmail",
  maps: "maps",
  "google maps": "maps",
  discord: "discord",
  slack: "slack",
};

const APP_DISPLAY_NAMES: Record<string, string> = {
  vscode: "Visual Studio Code",
  chrome: "Google Chrome",
  whatsapp: "WhatsApp",
  youtube: "YouTube",
  instagram: "Instagram",
  spotify: "Spotify",
  notepad: "Notepad",
  calculator: "Calculator",
  terminal: "Terminal",
  explorer: "File Explorer",
  files: "Files",
  edge: "Microsoft Edge",
  settings: "Settings",
  camera: "Camera",
  gmail: "Gmail",
  maps: "Google Maps",
  discord: "Discord",
  slack: "Slack",
};

export function normalizeAppAlias(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw.trim().toLowerCase().replace(/[.!?]+$/, "");
  return APP_ALIAS_MAP[cleaned] ?? cleaned;
}

export function formatAppDisplayName(raw: string): string {
  const normalized = normalizeAppAlias(raw);
  if (APP_DISPLAY_NAMES[normalized]) return APP_DISPLAY_NAMES[normalized];
  return raw.trim();
}

export interface TargetResolutionResult {
  devices: PublicDeviceRecord[];
  isBroadcastAll: boolean;
  needsClarification: boolean;
  clarificationPrompt?: string;
}

export function resolveTargetDevices(
  rawTarget: string | null | undefined,
  devices: PublicDeviceRecord[],
  currentDeviceId?: string | null,
): TargetResolutionResult {
  const activeDevices = devices.filter((d) => !d.revokedAt);
  const query = (rawTarget ?? "").trim().toLowerCase();

  if (
    query === "all" ||
    query === "all devices" ||
    query === "all my devices" ||
    query === "every device" ||
    query === "everywhere"
  ) {
    if (activeDevices.length === 0) {
      return {
        devices: [],
        isBroadcastAll: true,
        needsClarification: false,
        clarificationPrompt:
          "No devices are registered yet. Open the Devices panel to pair your laptop or phone.",
      };
    }
    return {
      devices: activeDevices,
      isBroadcastAll: true,
      needsClarification: false,
    };
  }

  if (!query || query === "current" || query === "this device") {
    if (currentDeviceId) {
      const current = activeDevices.find((d) => d.id === currentDeviceId);
      if (current) {
        return {
          devices: [current],
          isBroadcastAll: false,
          needsClarification: false,
        };
      }
    }

    const online = activeDevices.filter((d) => d.online);
    if (online.length === 1) {
      return {
        devices: [online[0]],
        isBroadcastAll: false,
        needsClarification: false,
      };
    }
    if (activeDevices.length === 0) {
      return {
        devices: [],
        isBroadcastAll: false,
        needsClarification: true,
        clarificationPrompt:
          "No devices are paired with ULTRON yet. Open Devices and pair your laptop or phone first.",
      };
    }

    const names = activeDevices.map((d) => d.name).join(", ");
    return {
      devices: [],
      isBroadcastAll: false,
      needsClarification: true,
      clarificationPrompt: `Which device should I target? Available devices: ${names}.`,
    };
  }

  // Exact name or explicit alias match first
  const exactMatches = activeDevices.filter(
    (d) =>
      d.name.toLowerCase() === query ||
      d.aliases.some((alias) => alias.toLowerCase() === query),
  );
  if (exactMatches.length > 0) {
    return {
      devices: exactMatches,
      isBroadcastAll: false,
      needsClarification: false,
    };
  }

  // Partial / semantic type matching ("my android", "sagar's phone", "work laptop")
  const partialMatches = activeDevices.filter((d) => {
    const nameMatch =
      d.name.toLowerCase().includes(query) || query.includes(d.name.toLowerCase());
    const aliasMatch = d.aliases.some(
      (a) => a.toLowerCase().includes(query) || query.includes(a.toLowerCase()),
    );
    const typeHint =
      (query.includes("phone") || query.includes("android") || query.includes("mobile")) &&
      d.type === "android"
        ? true
        : (query.includes("laptop") ||
              query.includes("windows") ||
              query.includes("pc") ||
              query.includes("desktop")) &&
            d.type === "windows";
    return nameMatch || aliasMatch || typeHint;
  });

  if (partialMatches.length === 1) {
    return {
      devices: partialMatches,
      isBroadcastAll: false,
      needsClarification: false,
    };
  }

  if (partialMatches.length > 1) {
    // Prefer online match if unambiguous among online devices
    const onlinePartial = partialMatches.filter((d) => d.online);
    if (onlinePartial.length === 1) {
      return {
        devices: onlinePartial,
        isBroadcastAll: false,
        needsClarification: false,
      };
    }
    return {
      devices: [],
      isBroadcastAll: false,
      needsClarification: true,
      clarificationPrompt: `Multiple devices match "${rawTarget}": ${partialMatches.map((d) => d.name).join(", ")}. Please specify by exact name.`,
    };
  }

  return {
    devices: [],
    isBroadcastAll: false,
    needsClarification: true,
    clarificationPrompt:
      activeDevices.length > 0
        ? `I couldn't find a registered device matching "${rawTarget}". Registered devices: ${activeDevices.map((d) => d.name).join(", ")}.`
        : `No devices are registered matching "${rawTarget}". Pair a device in the Devices drawer first.`,
  };
}

export function findInstalledApp(
  installedApps: InstalledApp[],
  rawApplication: string,
): InstalledApp | null {
  const normalized = normalizeAppAlias(rawApplication);
  const rawLower = rawApplication.trim().toLowerCase();
  return (
    installedApps.find(
      (app) =>
        app.alias.toLowerCase() === normalized ||
        app.alias.toLowerCase() === rawLower ||
        app.displayName.toLowerCase() === rawLower ||
        app.displayName.toLowerCase().includes(rawLower) ||
        app.identifier.toLowerCase() === rawLower,
    ) ?? null
  );
}

export interface PlannedDeviceDispatch {
  device: PublicDeviceRecord;
  action: DeviceAction;
  application?: string;
  applicationDisplay?: string;
}

export interface CommandValidationPlan {
  status:
    | "ready"
    | "immediate_response"
    | "confirmation_required"
    | "clarification_needed"
    | "error";
  spokenResponse: string;
  dispatches: PlannedDeviceDispatch[];
  rejectedDevices: Array<{ deviceName: string; reason: string }>;
  pendingConfirmation?: {
    intent: ParsedCommandIntent["intent"];
    targetDeviceIds: string[];
    application: string | null;
    summary: string;
  };
}

export function validateCommandPlan(
  parsed: ParsedCommandIntent,
  devices: PublicDeviceRecord[],
  options: { currentDeviceId?: string | null; confirmed?: boolean } = {},
): CommandValidationPlan {
  const active = devices.filter((d) => !d.revokedAt);

  if (parsed.intent === "SET_THEME") {
    const themeId = normalizeThemeId(parsed.theme);
    return {
      status: "immediate_response",
      spokenResponse:
        parsed.spokenSummary || ENERGY_THEMES[themeId].activationMessage,
      dispatches: [],
      rejectedDevices: [],
    };
  }

  if (parsed.intent === "HELP") {
    return {
      status: "immediate_response",
      spokenResponse:
        'Try commands like "Open WhatsApp on my phone", "Switch to blue mode", "Change your color to red", "Check my phone battery", or "Show my connected devices."',
      dispatches: [],
      rejectedDevices: [],
    };
  }

  if (parsed.intent === "UNKNOWN") {
    return {
      status: "clarification_needed",
      spokenResponse:
        parsed.spokenSummary ||
        "I could not match that to a supported device command. Ask me to open an app, check battery, list connected devices, lock, or request unlock.",
      dispatches: [],
      rejectedDevices: [],
    };
  }

  if (parsed.intent === "LIST_DEVICES") {
    if (active.length === 0) {
      return {
        status: "immediate_response",
        spokenResponse:
          "No devices are registered yet. Open the Devices panel to pair your laptop or phone.",
        dispatches: [],
        rejectedDevices: [],
      };
    }

    const online = active.filter((d) => d.online);
    const offline = active.filter((d) => !d.online);

    if (online.length === 0) {
      return {
        status: "immediate_response",
        spokenResponse: `You have ${active.length} registered device${active.length > 1 ? "s" : ""} (${active.map((d) => d.name).join(", ")}), but ${active.length > 1 ? "they are" : "it is"} currently offline.`,
        dispatches: [],
        rejectedDevices: [],
      };
    }

    const onlineNames = online.map((d) => d.name).join(" and ");
    const offlineSuffix =
      offline.length > 0
        ? ` Offline: ${offline.map((d) => d.name).join(", ")}.`
        : "";
    return {
      status: "immediate_response",
      spokenResponse: `${onlineNames} ${online.length > 1 ? "are" : "is"} connected.${offlineSuffix}`,
      dispatches: [],
      rejectedDevices: [],
    };
  }

  // CHECK_BATTERY can inspect all active devices when no device was specified
  if (parsed.intent === "CHECK_BATTERY" && !parsed.targetDevice) {
    const targets = active.filter((d) => d.online);
    if (targets.length === 0) {
      return {
        status: "error",
        spokenResponse:
          active.length === 0
            ? "No devices are registered yet."
            : "All registered devices are currently offline, so I cannot read live battery telemetry.",
        dispatches: [],
        rejectedDevices: [],
      };
    }
    return {
      status: "ready",
      spokenResponse: `Checking battery on ${targets.map((d) => d.name).join(" and ")}.`,
      dispatches: targets.map((device) => ({
        device,
        action: "CHECK_BATTERY",
      })),
      rejectedDevices: [],
    };
  }

  const resolution = resolveTargetDevices(
    parsed.targetDevice,
    active,
    options.currentDeviceId,
  );
  if (resolution.needsClarification || resolution.devices.length === 0) {
    return {
      status: "clarification_needed",
      spokenResponse:
        resolution.clarificationPrompt ??
        "Please specify which registered device you want to control.",
      dispatches: [],
      rejectedDevices: [],
    };
  }

  const action = parsed.intent as DeviceAction;
  const dispatches: PlannedDeviceDispatch[] = [];
  const rejectedDevices: Array<{ deviceName: string; reason: string }> = [];

  for (const device of resolution.devices) {
    if (!device.online) {
      rejectedDevices.push({
        deviceName: device.name,
        reason: `${device.name} is offline.`,
      });
      continue;
    }

    if (!device.supportedActions.includes(action)) {
      rejectedDevices.push({
        deviceName: device.name,
        reason: `${device.name} does not support ${action.toLowerCase().replace(/_/g, " ")}.`,
      });
      continue;
    }

    if (action === "OPEN_APPLICATION") {
      const rawApp = (parsed.application ?? "").trim();
      if (!rawApp) {
        return {
          status: "clarification_needed",
          spokenResponse: `Which application should I open on ${device.name}?`,
          dispatches: [],
          rejectedDevices: [],
        };
      }

      const normalizedApp = normalizeAppAlias(rawApp);
      const displayApp = formatAppDisplayName(rawApp);

      if (device.installedApps.length > 0) {
        const matchedApp = findInstalledApp(device.installedApps, rawApp);
        if (!matchedApp) {
          rejectedDevices.push({
            deviceName: device.name,
            reason: `${displayApp} is not in ${device.name}'s installed/allowlisted app registry.`,
          });
          continue;
        }
        dispatches.push({
          device,
          action: "OPEN_APPLICATION",
          application: matchedApp.alias,
          applicationDisplay: matchedApp.displayName,
        });
      } else {
        dispatches.push({
          device,
          action: "OPEN_APPLICATION",
          application: normalizedApp,
          applicationDisplay: displayApp,
        });
      }
    } else {
      dispatches.push({ device, action });
    }
  }

  if (dispatches.length === 0) {
    return {
      status: "error",
      spokenResponse:
        rejectedDevices.map((r) => r.reason).join(" ") ||
        "Target device could not execute the command.",
      dispatches: [],
      rejectedDevices,
    };
  }

  // Sensitive actions require explicit confirmation unless already confirmed
  const isSensitive =
    action === "LOCK_DEVICE" || parsed.requiresConfirmation === true;
  if (isSensitive && !options.confirmed) {
    const targetNames = dispatches.map((d) => d.device.name).join(" and ");
    const summary =
      action === "LOCK_DEVICE"
        ? `Lock ${targetNames}`
        : `${action} on ${targetNames}`;
    return {
      status: "confirmation_required",
      spokenResponse: `Confirmation required: ${summary}.`,
      dispatches,
      rejectedDevices,
      pendingConfirmation: {
        intent: parsed.intent,
        targetDeviceIds: dispatches.map((d) => d.device.id),
        application: parsed.application,
        summary,
      },
    };
  }

  const targetNames = dispatches.map((d) => d.device.name).join(" and ");
  let spokenResponse = `Sending command to ${targetNames}.`;
  if (action === "OPEN_APPLICATION") {
    const appLabel = dispatches[0]?.applicationDisplay ?? parsed.application ?? "application";
    spokenResponse =
      dispatches.length === 1
        ? `Connecting to ${targetNames}. Opening ${appLabel}.`
        : `Opening ${appLabel} on ${targetNames}.`;
  } else if (action === "UNLOCK_REQUEST") {
    spokenResponse = `Sending unlock request to ${targetNames}. You must authenticate directly on the device.`;
  } else if (action === "LOCK_DEVICE") {
    spokenResponse = `Sending lock command to ${targetNames}.`;
  }

  return {
    status: "ready",
    spokenResponse,
    dispatches,
    rejectedDevices,
  };
}
