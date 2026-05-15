export type ScreenshotTheme = "dark" | "light";

export type ScreenshotCaptureKind = "preset" | "panel";

export type ScreenshotPresetId =
  | "builtin:default"
  | "builtin:plan"
  | "builtin:chat-main"
  | "builtin:review"
  | "builtin:codex-main";

export type ScreenshotPanelId =
  | "scenes"
  | "editor"
  | "chat"
  | "chat-history"
  | "codex"
  | "codex-quick"
  | "snippets"
  | "attribution"
  | "timeline"
  | "map"
  | "kouetsu"
  | "foreshadow"
  | "grid"
  | "matrix"
  | "trash-bin";

export type ScreenshotAction =
  | "select-scene"
  | "select-codex"
  | "select-snippet"
  | "fit-map";

export interface ScreenshotCapture {
  id: string;
  kind: ScreenshotCaptureKind;
  presetId?: ScreenshotPresetId;
  panelId?: ScreenshotPanelId;
  theme: ScreenshotTheme;
  width: number;
  height: number;
  scale: number;
  output: string;
  actions?: readonly ScreenshotAction[];
}

export const DEFAULT_SCREENSHOT_DIR = "docs/screenshots/generated";

const SIZE_1080P = {
  theme: "dark",
  width: 1920,
  height: 1080,
  scale: 1,
} as const;

const PANEL_CAPTURES: readonly Omit<
  ScreenshotCapture,
  "kind" | "theme" | "scale" | "output"
>[] = [
  {
    id: "panel-scenes-460x650",
    panelId: "scenes",
    width: 460,
    height: 650,
    actions: ["select-scene"],
  },
  {
    id: "panel-codex-quick-460x650",
    panelId: "codex-quick",
    width: 460,
    height: 650,
    actions: ["select-scene"],
  },
  {
    id: "panel-attribution-460x280",
    panelId: "attribution",
    width: 460,
    height: 280,
    actions: ["select-scene"],
  },
  {
    id: "panel-chat-850x650",
    panelId: "chat",
    width: 850,
    height: 650,
    actions: ["select-scene"],
  },
  {
    id: "panel-chat-history-850x650",
    panelId: "chat-history",
    width: 850,
    height: 650,
  },
  {
    id: "panel-codex-850x650",
    panelId: "codex",
    width: 850,
    height: 650,
    actions: ["select-codex"],
  },
  {
    id: "panel-matrix-850x650",
    panelId: "matrix",
    width: 850,
    height: 650,
  },
  {
    id: "panel-foreshadow-850x650",
    panelId: "foreshadow",
    width: 850,
    height: 650,
  },
  {
    id: "panel-snippets-850x650",
    panelId: "snippets",
    width: 850,
    height: 650,
    actions: ["select-snippet"],
  },
  {
    id: "panel-timeline-790x200",
    panelId: "timeline",
    width: 790,
    height: 200,
  },
  {
    id: "panel-grid-1080x890",
    panelId: "grid",
    width: 1080,
    height: 890,
  },
  {
    id: "panel-map-1080x890",
    panelId: "map",
    width: 1080,
    height: 890,
    actions: ["fit-map"],
  },
  {
    id: "panel-kouetsu-850x650",
    panelId: "kouetsu",
    width: 850,
    height: 650,
    actions: ["select-scene"],
  },
  {
    id: "panel-editor-1080x890",
    panelId: "editor",
    width: 1080,
    height: 890,
    actions: ["select-scene"],
  },
  {
    id: "panel-trash-bin-850x650",
    panelId: "trash-bin",
    width: 850,
    height: 650,
  },
] as const;

export const SCREENSHOT_CAPTURES: readonly ScreenshotCapture[] = [
  {
    id: "preset-default-1920x1080",
    kind: "preset",
    presetId: "builtin:default",
    output: "preset-default-1920x1080.png",
    ...SIZE_1080P,
  },
  {
    id: "preset-plan-1920x1080",
    kind: "preset",
    presetId: "builtin:plan",
    output: "preset-plan-1920x1080.png",
    ...SIZE_1080P,
  },
  {
    id: "preset-chat-main-1920x1080",
    kind: "preset",
    presetId: "builtin:chat-main",
    output: "preset-chat-main-1920x1080.png",
    ...SIZE_1080P,
  },
  {
    id: "preset-review-1920x1080",
    kind: "preset",
    presetId: "builtin:review",
    output: "preset-review-1920x1080.png",
    ...SIZE_1080P,
  },
  {
    id: "preset-codex-main-1920x1080",
    kind: "preset",
    presetId: "builtin:codex-main",
    output: "preset-codex-main-1920x1080.png",
    ...SIZE_1080P,
  },
  ...PANEL_CAPTURES.map((capture) => ({
    ...capture,
    kind: "panel" as const,
    theme: "dark" as const,
    scale: 1,
    output: `${capture.id}.png`,
  })),
] as const;

export const SCREENSHOT_CAPTURE_IDS = SCREENSHOT_CAPTURES.map(
  (capture) => capture.id,
);

export function findScreenshotCapture(id: string) {
  return SCREENSHOT_CAPTURES.find((capture) => capture.id === id);
}
