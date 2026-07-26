import { describe, expect, it } from "vitest";
import { TOOL_WINDOW_PANEL_IDS } from "@/features/layout/toolWindowDefaults";
import {
  DEFAULT_SCREENSHOT_COLOR_THEME,
  DEFAULT_SCREENSHOT_DIR,
  DEFAULT_SCREENSHOT_THEME,
  SCREENSHOT_CAPTURES,
  screenshotOutputFilename,
  type ScreenshotPanelId,
  type ScreenshotPresetId,
} from "./captureManifest";

describe("screenshotOutputFilename", () => {
  it("strips trailing -WxH from capture ids", () => {
    expect(screenshotOutputFilename("panel-editor-1080x890")).toBe(
      "panel-editor.png",
    );
    expect(screenshotOutputFilename("preset-default-1920x1080")).toBe(
      "preset-default.png",
    );
    expect(screenshotOutputFilename("panel-scenes-460x650")).toBe(
      "panel-scenes.png",
    );
  });

  it("omits suffixes when theme/colorTheme are the defaults", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", {
        theme: DEFAULT_SCREENSHOT_THEME,
        colorTheme: DEFAULT_SCREENSHOT_COLOR_THEME,
      }),
    ).toBe("panel-editor.png");
  });

  it("appends a theme suffix only for non-default appearance", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", { theme: "light" }),
    ).toBe("panel-editor-light.png");
  });

  it("appends a colorTheme suffix only for non-default palette", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", {
        colorTheme: "modern-mystic",
      }),
    ).toBe("panel-editor-modern-mystic.png");
  });

  it("combines theme and colorTheme suffixes in a stable order", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", {
        theme: "light",
        colorTheme: "warm-craft",
      }),
    ).toBe("panel-editor-light-warm-craft.png");
  });

  it("omits the language suffix for the default language (ja)", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", { language: "ja" }),
    ).toBe("panel-editor.png");
  });

  it("appends a trailing language suffix for non-default languages", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", { language: "en" }),
    ).toBe("panel-editor-en.png");
  });

  it("orders the language suffix last, after theme and colorTheme", () => {
    expect(
      screenshotOutputFilename("panel-editor-1080x890", {
        theme: "light",
        colorTheme: "warm-craft",
        language: "en",
      }),
    ).toBe("panel-editor-light-warm-craft-en.png");
  });
});

describe("SCREENSHOT_CAPTURES", () => {
  it("defines every built-in layout preset at 1920x1080", () => {
    const presets = new Set<ScreenshotPresetId>(
      SCREENSHOT_CAPTURES.flatMap((capture) =>
        capture.presetId ? [capture.presetId] : [],
      ),
    );

    expect(presets).toEqual(
      new Set([
        "builtin:default",
        "builtin:plan",
        "builtin:chat-main",
        "builtin:review",
        "builtin:codex-main",
      ]),
    );
    expect(
      SCREENSHOT_CAPTURES.filter((capture) => capture.kind === "preset").every(
        (capture) => capture.width === 1920 && capture.height === 1080,
      ),
    ).toBe(true);
  });

  it("defines one capture for each app panel at its LP crop size", () => {
    const panelCaptures = SCREENSHOT_CAPTURES.filter(
      (capture) => capture.kind === "panel",
    );
    const panels = new Set<ScreenshotPanelId>(
      panelCaptures.flatMap((capture) =>
        capture.panelId ? [capture.panelId] : [],
      ),
    );

    const registeredPanels = ["editor", ...TOOL_WINDOW_PANEL_IDS];
    expect(panels).toEqual(new Set(registeredPanels));
    expect(panelCaptures).toHaveLength(registeredPanels.length);
    expect(
      Object.fromEntries(
        panelCaptures.map((capture) => [
          capture.panelId,
          {
            width: capture.width,
            height: capture.height,
            actions: capture.actions ?? [],
          },
        ]),
      ),
    ).toEqual({
      scenes: { width: 460, height: 650, actions: ["select-scene"] },
      editor: { width: 1080, height: 890, actions: ["select-scene"] },
      chat: { width: 850, height: 650, actions: ["select-scene"] },
      "chat-history": { width: 850, height: 650, actions: [] },
      codex: { width: 850, height: 650, actions: ["select-codex"] },
      "codex-quick": { width: 460, height: 650, actions: ["select-scene"] },
      snippets: { width: 850, height: 650, actions: ["select-snippet"] },
      attribution: { width: 460, height: 280, actions: ["select-scene"] },
      timeline: { width: 790, height: 200, actions: [] },
      chronicle: { width: 1080, height: 890, actions: [] },
      map: { width: 1080, height: 890, actions: ["fit-map"] },
      kouetsu: { width: 850, height: 650, actions: ["select-scene"] },
      foreshadow: { width: 850, height: 650, actions: [] },
      grid: { width: 1080, height: 890, actions: [] },
      matrix: { width: 850, height: 650, actions: [] },
      "writing-stats": { width: 850, height: 650, actions: [] },
      "trash-bin": { width: 850, height: 650, actions: [] },
      "command-center-results": {
        width: 460,
        height: 650,
        actions: ["search-command-center"],
      },
    });
  });

  it("uses unique ids and png output names", () => {
    const ids = SCREENSHOT_CAPTURES.map((capture) => capture.id);
    const outputs = SCREENSHOT_CAPTURES.map((capture) => capture.output);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(outputs).size).toBe(outputs.length);
    expect(outputs.every((output) => output.endsWith(".png"))).toBe(true);
    expect(ids.some((id) => id.includes("mobile"))).toBe(false);
  });

  it("keeps generated screenshots isolated from existing docs screenshots", () => {
    expect(DEFAULT_SCREENSHOT_DIR).toBe("docs/screenshots/generated");
  });
});
