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
  // 生成自体が窓を登録する。WebviewWindow は内部で失敗時 `tauri://error` を
  // 自イベントへ流すので unhandled rejection でクラッシュはしない。ただし
  // 現状その失敗は無通知。Phase 2 で開くボタンを配線する際、呼び出し側で
  // `win.once("tauri://error", …)` を listen してユーザー通知すること（TODO）。
  new WebviewWindow(label, options);
}
