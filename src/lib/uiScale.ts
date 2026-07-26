import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import {
  SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT,
  SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT,
} from "@/screenshot-scenes/captureManifest";
import { isScreenshotStagingActive } from "@/screenshot-scenes/screenshotMode";
import { electronBridge, isElectron } from "@/lib/shell";
import { isTauri } from "@/lib/tauri";

export const UI_SCALE_MIN_PCT = SCREENSHOT_CAPTURE_UI_SCALE_MIN_PCT;

/**
 * Settings パネルと通常運用での UI スケール上限（%）。
 * スクリーンショット staging の上限は captureManifest の
 * SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT と一致させること。
 */
export const UI_SCALE_MAX_PCT_SETTINGS = 150;

/** @deprecated {@link UI_SCALE_MAX_PCT_SETTINGS} を参照してください */
export const UI_SCALE_MAX_PCT = UI_SCALE_MAX_PCT_SETTINGS;

export function getUiScaleMaxPercent(): number {
  return isScreenshotStagingActive()
    ? SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT
    : UI_SCALE_MAX_PCT_SETTINGS;
}

export function clampUiScalePercent(rawPercent: number | undefined): number {
  const v = rawPercent ?? 100;
  const max = getUiScaleMaxPercent();
  return Math.min(max, Math.max(UI_SCALE_MIN_PCT, v));
}

export function uiScalePercentToFactor(rawPercent: number | undefined): number {
  return clampUiScalePercent(rawPercent) / 100;
}

export type UiScaleSyncAbort = { cancelled: boolean };

/**
 * Applies global UI scale: Tauri WebView `setZoom` / Electron main の
 * `setZoomFactor`（sandbox preload の webFrame 制約を踏まないよう main 経由に
 * 統一 — 設計書 §3.4）when available, otherwise
 * `document.documentElement.style.zoom`. Sets `--ui-scale` for auxiliary use.
 */
export async function syncUiScaleFromGlobalSettings(
  globalSettings: GlobalSettings | null,
  abort?: UiScaleSyncAbort,
): Promise<void> {
  const html = document.documentElement;
  const cancelled = () => abort?.cancelled ?? false;

  const factor =
    globalSettings == null ? 1 : uiScalePercentToFactor(globalSettings.uiScale);

  html.style.setProperty("--ui-scale", String(factor));

  const applyCssZoom = () => {
    if (factor === 1) {
      html.style.removeProperty("zoom");
    } else {
      html.style.zoom = String(factor);
    }
  };

  if (isTauri()) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      if (cancelled()) return;
      await getCurrentWebview().setZoom(factor);
      if (cancelled()) return;
      html.style.removeProperty("zoom");
    } catch {
      if (cancelled()) return;
      applyCssZoom();
    }
    return;
  }

  if (isElectron()) {
    try {
      await electronBridge().setZoomFactor(factor);
      if (cancelled()) return;
      html.style.removeProperty("zoom");
    } catch {
      if (cancelled()) return;
      applyCssZoom();
    }
    return;
  }

  applyCssZoom();
}
