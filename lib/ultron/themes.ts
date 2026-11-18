export type EnergyThemeId = "orange" | "red" | "blue";

export interface EnergyThemeSpec {
  id: EnergyThemeId;
  name: string;
  shortLabel: string;
  primary: string;
  secondary: string;
  energyCore: string;
  glowDescription: string;
  activationMessage: string;
  restoredMessage: string;
  orbColors: {
    bright: number;
    mid: number;
    dim: number;
    faint: number;
    hot: number;
  };
  shader: {
    channelWeight: [number, number, number];
    tint: [number, number, number];
    tintMix: number;
  };
  hud: {
    text: string;
    bright: string;
    primaryRgb: string;
    secondaryRgb: string;
    coreRgb: string;
    surfaceBg: string;
    surfaceHoverBg: string;
    surfaceActiveBg: string;
    panelBg: string;
    cameraBg: string;
    cameraFilter: string;
  };
}

export const DEFAULT_ENERGY_THEME: EnergyThemeId = "orange";
export const ENERGY_THEME_STORAGE_KEY = "ultron_energy_core_theme_v1";

export const ENERGY_THEMES: Record<EnergyThemeId, EnergyThemeSpec> = {
  orange: {
    id: "orange",
    name: "Inferno Orange",
    shortLabel: "Inferno",
    primary: "#FF8C00",
    secondary: "#FF4500",
    energyCore: "#FFD700",
    glowDescription: "Warm orange/gold",
    activationMessage: "Inferno Orange energy core activated.",
    restoredMessage: "Inferno Orange restored.",
    orbColors: {
      bright: 0xffaa30,
      mid: 0xdd7700,
      dim: 0x884400,
      faint: 0x553300,
      hot: 0xffd700,
    },
    shader: {
      channelWeight: [1.0, 1.05, 0.6],
      tint: [1.15, 0.85, 0.55],
      tintMix: 0.3,
    },
    hud: {
      text: "#ffaa30",
      bright: "#ffcc66",
      primaryRgb: "255, 170, 48",
      secondaryRgb: "255, 69, 0",
      coreRgb: "255, 215, 0",
      surfaceBg: "rgba(16, 8, 0, 0.84)",
      surfaceHoverBg: "rgba(55, 26, 0, 0.9)",
      surfaceActiveBg: "rgba(110, 52, 0, 0.85)",
      panelBg: "rgba(12, 6, 0, 0.92)",
      cameraBg: "#0a0500",
      cameraFilter:
        "sepia(1) hue-rotate(-15deg) saturate(2.2) brightness(0.75) contrast(1.15)",
    },
  },
  red: {
    id: "red",
    name: "Crimson Red",
    shortLabel: "Crimson",
    primary: "#FF0033",
    secondary: "#B3001B",
    energyCore: "#FF1744",
    glowDescription: "Deep crimson/red plasma",
    activationMessage: "Crimson Red energy core activated.",
    restoredMessage: "Crimson Red energy core activated.",
    orbColors: {
      bright: 0xff0033,
      mid: 0xb3001b,
      dim: 0x7a0014,
      faint: 0x42000a,
      hot: 0xff1744,
    },
    shader: {
      channelWeight: [1.12, 0.82, 0.9],
      tint: [1.18, 0.42, 0.48],
      tintMix: 0.24,
    },
    hud: {
      text: "#ff3b5c",
      bright: "#ff758f",
      primaryRgb: "255, 0, 51",
      secondaryRgb: "179, 0, 27",
      coreRgb: "255, 23, 68",
      surfaceBg: "rgba(22, 3, 7, 0.86)",
      surfaceHoverBg: "rgba(70, 8, 18, 0.92)",
      surfaceActiveBg: "rgba(128, 10, 28, 0.88)",
      panelBg: "rgba(16, 3, 7, 0.94)",
      cameraBg: "#0c0204",
      cameraFilter:
        "sepia(1) hue-rotate(-48deg) saturate(2.6) brightness(0.72) contrast(1.18)",
    },
  },
  blue: {
    id: "blue",
    name: "Arc Reactor Blue",
    shortLabel: "Arc Blue",
    primary: "#00BFFF",
    secondary: "#0066FF",
    energyCore: "#00FFFF",
    glowDescription: "Electric blue/cyan plasma",
    activationMessage: "Arc Reactor Blue activated.",
    restoredMessage: "Arc Reactor Blue activated.",
    orbColors: {
      bright: 0x00bfff,
      mid: 0x0088ff,
      dim: 0x0066ff,
      faint: 0x003380,
      hot: 0x00ffff,
    },
    shader: {
      channelWeight: [0.85, 1.04, 1.18],
      tint: [0.55, 0.95, 1.2],
      tintMix: 0.24,
    },
    hud: {
      text: "#29ccff",
      bright: "#70ffff",
      primaryRgb: "0, 191, 255",
      secondaryRgb: "0, 102, 255",
      coreRgb: "0, 255, 255",
      surfaceBg: "rgba(2, 12, 24, 0.86)",
      surfaceHoverBg: "rgba(6, 40, 72, 0.92)",
      surfaceActiveBg: "rgba(0, 88, 148, 0.86)",
      panelBg: "rgba(2, 10, 20, 0.94)",
      cameraBg: "#020810",
      cameraFilter:
        "sepia(1) hue-rotate(155deg) saturate(2.4) brightness(0.76) contrast(1.15)",
    },
  },
};

export const ENERGY_THEME_LIST: EnergyThemeSpec[] = [
  ENERGY_THEMES.orange,
  ENERGY_THEMES.red,
  ENERGY_THEMES.blue,
];

export function isEnergyThemeId(value: unknown): value is EnergyThemeId {
  return value === "orange" || value === "red" || value === "blue";
}

export function normalizeThemeId(value: unknown): EnergyThemeId {
  return isEnergyThemeId(value) ? value : DEFAULT_ENERGY_THEME;
}

export interface DetectedThemeCommand {
  theme: EnergyThemeId;
  spokenResponse: string;
}

/**
 * Deterministically detects voice or text commands intended to customize ULTRON's
 * energy core color theme so voice controls and manual UI controls share one pipeline.
 */
export function detectThemeCommand(rawText: string): DetectedThemeCommand | null {
  const cleaned = rawText
    .trim()
    .toLowerCase()
    .replace(/^hey\s+ultron[\s,.:!?-]*/i, "")
    .replace(/^ultron[\s,.:!?-]*/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();

  if (!cleaned) return null;

  const hasColorIntentContext =
    /\b(colou?r|theme|mode|core|energy|glow|orb|reactor|inferno|crimson|original|default|restore|reset|switch|change|activate|set|turn|make)\b/.test(
      cleaned,
    );

  if (!hasColorIntentContext) return null;

  if (
    /\b(crimson(?:\s+red)?)\b/.test(cleaned) ||
    (/\bred\b/.test(cleaned) &&
      /\b(colou?r|theme|mode|core|energy|glow|orb|switch|change|activate|set|turn|make)\b/.test(
        cleaned,
      ))
  ) {
    return {
      theme: "red",
      spokenResponse: ENERGY_THEMES.red.activationMessage,
    };
  }

  if (
    /\b(arc\s+reactor(?:\s+blue)?|arc\s+blue)\b/.test(cleaned) ||
    (/\b(blue|cyan)\b/.test(cleaned) &&
      /\b(colou?r|theme|mode|core|energy|glow|orb|switch|change|activate|set|turn|make)\b/.test(
        cleaned,
      ))
  ) {
    return {
      theme: "blue",
      spokenResponse: ENERGY_THEMES.blue.activationMessage,
    };
  }

  const asksOriginalOrDefault =
    /\b(original|default|classic)\b/.test(cleaned) &&
    /\b(theme|colou?r|mode|core|energy|restore|reset|activate|switch|back)\b/.test(
      cleaned,
    );
  const asksInfernoOrOrange =
    /\b(inferno(?:\s+orange)?)\b/.test(cleaned) ||
    (/\b(orange|gold|amber)\b/.test(cleaned) &&
      /\b(colou?r|theme|mode|core|energy|glow|orb|switch|change|activate|restore|reset|set|turn|make)\b/.test(
        cleaned,
      ));

  if (asksOriginalOrDefault || asksInfernoOrOrange) {
    const isRestore =
      asksOriginalOrDefault || /\b(restore|reset|back)\b/.test(cleaned);
    return {
      theme: "orange",
      spokenResponse: isRestore
        ? ENERGY_THEMES.orange.restoredMessage
        : ENERGY_THEMES.orange.activationMessage,
    };
  }

  return null;
}

export function loadSavedTheme(storage?: Pick<Storage, "getItem"> | null): EnergyThemeId {
  const target =
    storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return DEFAULT_ENERGY_THEME;
  try {
    return normalizeThemeId(target.getItem(ENERGY_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_ENERGY_THEME;
  }
}

export function saveTheme(
  themeId: EnergyThemeId,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  const target =
    storage ?? (typeof window !== "undefined" ? window.localStorage : null);
  if (!target) return;
  try {
    target.setItem(ENERGY_THEME_STORAGE_KEY, themeId);
  } catch {
    // Ignore storage quota / private mode failures
  }
}

export function getThemeCssVariables(themeId: EnergyThemeId): Record<string, string> {
  const { hud, primary, secondary, energyCore } = ENERGY_THEMES[themeId];
  return {
    "--ultron-primary": primary,
    "--ultron-secondary": secondary,
    "--ultron-core": energyCore,
    "--ultron-hud-text": hud.text,
    "--ultron-hud-bright": hud.bright,
    "--ultron-primary-rgb": hud.primaryRgb,
    "--ultron-secondary-rgb": hud.secondaryRgb,
    "--ultron-core-rgb": hud.coreRgb,
    "--ultron-surface-bg": hud.surfaceBg,
    "--ultron-surface-hover": hud.surfaceHoverBg,
    "--ultron-surface-active": hud.surfaceActiveBg,
    "--ultron-panel-bg": hud.panelBg,
    "--ultron-camera-bg": hud.cameraBg,
    "--ultron-camera-filter": hud.cameraFilter,
  };
}
