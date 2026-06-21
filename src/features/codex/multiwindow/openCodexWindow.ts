import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauri } from "@/lib/tauri";
import { buildCodexWindowOptions } from "./codexWindowOptions";
import { CODEX_WINDOW_LABEL } from "./codexWindowMode";

/**
 * フローティング Codex ウィンドウを開く（既存なら focus）。
 * 非 Tauri 環境（ブラウザ/テスト）では no-op。glass shell 前提の
 * transparent/decorations:false は buildCodexWindowOptions が担保する。
 */
export async function openCodexWindow(): Promise<void> {
  if (!isTauri()) return;
  const existing = await WebviewWindow.getByLabel(CODEX_WINDOW_LABEL);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const { label, ...options } = buildCodexWindowOptions();
  // 生成自体が登録（戻り値は使わない。失敗イベントは呼び出し側 UI で扱う）。
  new WebviewWindow(label, options);
}
