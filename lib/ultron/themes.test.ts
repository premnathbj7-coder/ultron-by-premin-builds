import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_ENERGY_THEME,
  ENERGY_THEMES,
  ENERGY_THEME_STORAGE_KEY,
  detectThemeCommand,
  getThemeCssVariables,
  loadSavedTheme,
  normalizeThemeId,
  saveTheme,
} from "./themes";

describe("ULTRON energy core theme specs", () => {
  it("defines exact color specifications for all three themes", () => {
    assert.equal(DEFAULT_ENERGY_THEME, "orange");

    assert.equal(ENERGY_THEMES.orange.primary, "#FF8C00");
    assert.equal(ENERGY_THEMES.orange.secondary, "#FF4500");
    assert.equal(ENERGY_THEMES.orange.energyCore, "#FFD700");

    assert.equal(ENERGY_THEMES.red.primary, "#FF0033");
    assert.equal(ENERGY_THEMES.red.secondary, "#B3001B");
    assert.equal(ENERGY_THEMES.red.energyCore, "#FF1744");

    assert.equal(ENERGY_THEMES.blue.primary, "#00BFFF");
    assert.equal(ENERGY_THEMES.blue.secondary, "#0066FF");
    assert.equal(ENERGY_THEMES.blue.energyCore, "#00FFFF");
  });

  it("normalizes unknown theme ids back to Inferno Orange", () => {
    assert.equal(normalizeThemeId("red"), "red");
    assert.equal(normalizeThemeId("blue"), "blue");
    assert.equal(normalizeThemeId("green"), "orange");
    assert.equal(normalizeThemeId(null), "orange");
  });

  it("persists and restores themes via storage adapter", () => {
    const map = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };

    assert.equal(loadSavedTheme(mockStorage), "orange");
    saveTheme("blue", mockStorage);
    assert.equal(map.get(ENERGY_THEME_STORAGE_KEY), "blue");
    assert.equal(loadSavedTheme(mockStorage), "blue");

    map.set(ENERGY_THEME_STORAGE_KEY, "corrupted");
    assert.equal(loadSavedTheme(mockStorage), "orange");
  });

  it("generates complete CSS variable sets for every theme", () => {
    const vars = getThemeCssVariables("red");
    assert.equal(vars["--ultron-primary"], "#FF0033");
    assert.equal(vars["--ultron-secondary"], "#B3001B");
    assert.equal(vars["--ultron-core"], "#FF1744");
    assert.ok(vars["--ultron-hud-text"].length > 0);
  });
});

describe("detectThemeCommand", () => {
  it("detects voice commands for Crimson Red", () => {
    const res = detectThemeCommand("ULTRON, change your color to red.");
    assert.ok(res);
    assert.equal(res.theme, "red");
    assert.equal(res.spokenResponse, "Crimson Red energy core activated.");

    const res2 = detectThemeCommand("Activate crimson mode");
    assert.equal(res2?.theme, "red");
  });

  it("detects voice commands for Arc Reactor Blue", () => {
    const res = detectThemeCommand("ULTRON, switch to blue mode.");
    assert.ok(res);
    assert.equal(res.theme, "blue");
    assert.equal(res.spokenResponse, "Arc Reactor Blue activated.");

    const res2 = detectThemeCommand("Switch energy core to arc reactor");
    assert.equal(res2?.theme, "blue");
  });

  it("detects voice commands for Inferno Orange and original theme restore", () => {
    const res = detectThemeCommand("ULTRON, activate original theme.");
    assert.ok(res);
    assert.equal(res.theme, "orange");
    assert.equal(res.spokenResponse, "Inferno Orange restored.");

    const res2 = detectThemeCommand("Change color to orange");
    assert.equal(res2?.theme, "orange");
    assert.equal(res2?.spokenResponse, "Inferno Orange energy core activated.");
  });

  it("does not misclassify device automation commands as theme switches", () => {
    assert.equal(detectThemeCommand("ULTRON, open WhatsApp on my phone."), null);
    assert.equal(detectThemeCommand("Open Chrome on my laptop"), null);
    assert.equal(detectThemeCommand("Check my phone battery"), null);
    assert.equal(detectThemeCommand("Show my connected devices"), null);
  });
});
