import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREENSHOT_DIR,
  SCREENSHOT_CAPTURES,
  type ScreenshotPanelId,
  type ScreenshotPresetId,
} from "./captureManifest";

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

    expect(panels).toEqual(
      new Set([
        "scenes",
        "editor",
        "chat",
        "chat-history",
        "codex",
        "codex-quick",
        "snippets",
        "attribution",
        "timeline",
        "map",
        "kouetsu",
        "foreshadow",
        "grid",
        "matrix",
        "trash-bin",
      ]),
    );
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
      map: { width: 1080, height: 890, actions: ["fit-map"] },
      kouetsu: { width: 850, height: 650, actions: ["select-scene"] },
      foreshadow: { width: 850, height: 650, actions: [] },
      grid: { width: 1080, height: 890, actions: [] },
      matrix: { width: 850, height: 650, actions: [] },
      "trash-bin": { width: 850, height: 650, actions: [] },
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
