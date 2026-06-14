import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "../lib/colorThemes";
import {
  DEFAULT_SCREENSHOT_LANGUAGE,
  type ScreenshotLanguage,
} from "./screenshotMode";

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
  /**
   * dark/light モード。未指定時は CLI/env (`--theme` / `SCREENSHOT_THEME`)、
   * それも無ければ `DEFAULT_SCREENSHOT_THEME`（dark）。
   */
  theme?: ScreenshotTheme;
  /**
   * カラーテーマ ID（COLOR_THEMES のいずれか）。未指定時は CLI/env
   * (`--color-theme` / `SCREENSHOT_COLOR_THEME`)、それも無ければ
   * `DEFAULT_SCREENSHOT_COLOR_THEME`。
   */
  colorTheme?: string;
  width: number;
  height: number;
  /** devicePixelRatio 系（UI の uiScale / ％ズームとは別） */
  scale: number;
  output: string;
  actions?: readonly ScreenshotAction[];
  /**
   * アプリの UI スケール（%/整数）。staging では最大 500 まで許可される。
   * 未指定時は `pnpm screenshot -- --ui-scale` または `SCREENSHOT_UI_SCALE`、`100` の順。
   */
  uiScale?: number;
}

/** capture-screenshots.ts の `--ui-scale` / `SCREENSHOT_UI_SCALE` 検証にも使用 */
export const SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT = 80;
/** WebView 系のズーム目安上限に合わせた staging 上限 */
export const SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT = 500;

export const DEFAULT_SCREENSHOT_DIR = "docs/screenshots/generated";

/** 撮影時の dark/light デフォルト。manifest と CLI/env が両方未指定のときに使う。 */
export const DEFAULT_SCREENSHOT_THEME: ScreenshotTheme = "dark";

/** 撮影時のカラーテーマ ID デフォルト。アプリ既定値 (`DEFAULT_COLOR_THEME`) と揃える。 */
export const DEFAULT_SCREENSHOT_COLOR_THEME: string = DEFAULT_COLOR_THEME;

/** 有効な `--color-theme` 値（`SCREENSHOT_COLOR_THEME` 検証にも使用）。 */
export const SCREENSHOT_COLOR_THEME_IDS: readonly string[] = COLOR_THEMES.map(
  (theme) => theme.id,
);

/**
 * `-123x456` 形式の末尾サイズを除いた PNG ファイル名。
 * `opts.theme`/`opts.colorTheme`/`opts.language` がデフォルトと異なる場合のみ
 * 接尾辞を付け、既定（dark / dark-academia / ja）では従来どおり
 * `panel-editor.png` のような名前を返す。言語接尾辞は末尾に付く
 * （例: `panel-editor-en.png`, `panel-editor-light-en.png`）。
 */
export function screenshotOutputFilename(
  captureId: string,
  opts?: {
    theme?: ScreenshotTheme;
    colorTheme?: string;
    language?: ScreenshotLanguage;
  },
): string {
  const base = captureId.replace(/-\d+x\d+$/, "");
  const parts: string[] = [base];
  if (opts?.theme && opts.theme !== DEFAULT_SCREENSHOT_THEME) {
    parts.push(opts.theme);
  }
  if (opts?.colorTheme && opts.colorTheme !== DEFAULT_SCREENSHOT_COLOR_THEME) {
    parts.push(opts.colorTheme);
  }
  if (opts?.language && opts.language !== DEFAULT_SCREENSHOT_LANGUAGE) {
    parts.push(opts.language);
  }
  return `${parts.join("-")}.png`;
}

const SIZE_1080P = {
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
    output: screenshotOutputFilename("preset-default-1920x1080"),
    ...SIZE_1080P,
  },
  {
    id: "preset-plan-1920x1080",
    kind: "preset",
    presetId: "builtin:plan",
    output: screenshotOutputFilename("preset-plan-1920x1080"),
    ...SIZE_1080P,
  },
  {
    id: "preset-chat-main-1920x1080",
    kind: "preset",
    presetId: "builtin:chat-main",
    output: screenshotOutputFilename("preset-chat-main-1920x1080"),
    ...SIZE_1080P,
  },
  {
    id: "preset-review-1920x1080",
    kind: "preset",
    presetId: "builtin:review",
    output: screenshotOutputFilename("preset-review-1920x1080"),
    ...SIZE_1080P,
  },
  {
    id: "preset-codex-main-1920x1080",
    kind: "preset",
    presetId: "builtin:codex-main",
    output: screenshotOutputFilename("preset-codex-main-1920x1080"),
    ...SIZE_1080P,
  },
  ...PANEL_CAPTURES.map((capture) => ({
    ...capture,
    kind: "panel" as const,
    scale: 1,
    output: screenshotOutputFilename(capture.id),
  })),
] as const;

export const SCREENSHOT_CAPTURE_IDS = SCREENSHOT_CAPTURES.map(
  (capture) => capture.id,
);

export function findScreenshotCapture(id: string) {
  return SCREENSHOT_CAPTURES.find((capture) => capture.id === id);
}
