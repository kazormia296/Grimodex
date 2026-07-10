import { isTauri } from "@/lib/tauri";
import {
  createWebviewWindow,
  getWebviewWindowByLabel,
  type AppWindowHandle,
} from "@/lib/webviewWindows";
import type { PanelId } from "../panelIds";
import { TOGGLEABLE_PANELS } from "../panelRegions";

/**
 * 任意のパネルを別フローティングウィンドウに切り出す共通機構。
 *
 * - 窓は URL `index.html?window=panel&panel=<id>` で生成（capability label は
 *   `panel-<id>`、capability の windows scope は glob `panel-*`）。
 * - 判定は URL クエリを正本にする＝Tauri ランタイム非依存で happy-dom テスト可能。
 * - editor は中央執筆面なので別窓対象外。未知の panel 値は弾く（不正 URL で
 *   空の SlotView を描かないため）。
 */

export const PANEL_WINDOW_LABEL_PREFIX = "panel-";

const TOGGLEABLE_SET = new Set<string>(TOGGLEABLE_PANELS);

export function panelWindowLabel(panelId: PanelId): string {
  return `${PANEL_WINDOW_LABEL_PREFIX}${panelId}`;
}

/**
 * その panel を別窓に切り出してよいか（= 単独描画対象として受理されるか）。
 * 受理判定の正本。`parsePanelWindowTarget` の受理条件と必ず対称にする
 * （ここで true ⇔ `?panel=<id>` の窓が solo 描画される）。editor のような
 * 非 toggleable / 未知 panel を別窓化すると、生成窓は target=null となり
 * メイン窓扱い＝アプリ全体の複製窓を生むため弾く。
 */
export function canOpenPanelWindow(panelId: PanelId): boolean {
  return TOGGLEABLE_SET.has(panelId);
}

/** location.search 相当から、この窓が単独表示すべき panel を返す純関数。main 窓は null。 */
export function parsePanelWindowTarget(search: string): PanelId | null {
  const params = new URLSearchParams(search);
  if (params.get("window") !== "panel") return null;
  const panel = params.get("panel");
  if (panel && TOGGLEABLE_SET.has(panel)) return panel as PanelId;
  return null;
}

/** 現在の窓が単独表示すべき panel。main 窓 / ブラウザ外では null。 */
export function getPanelWindowTarget(): PanelId | null {
  if (typeof window === "undefined") return null;
  return parsePanelWindowTarget(window.location.search);
}

export function isPanelWindow(): boolean {
  return getPanelWindowTarget() !== null;
}

export interface PanelWindowOptions {
  label: string;
  url: string;
  transparent: boolean;
  decorations: boolean;
  width: number;
  height: number;
  title: string;
}

export function buildPanelWindowOptions(panelId: PanelId): PanelWindowOptions {
  return {
    label: panelWindowLabel(panelId),
    url: `index.html?window=panel&panel=${encodeURIComponent(panelId)}`,
    // glass shell 前提（指定しないと枠付き不透明窓で崩れる。検討メモ §4.1）。
    transparent: true,
    decorations: false,
    width: 480,
    height: 900,
    title: panelId.charAt(0).toUpperCase() + panelId.slice(1),
  };
}

/**
 * パネルを別窓で開く（既存なら focus）。非 Tauri 環境では no-op。
 * WebviewWindow は失敗時 `tauri://error` を自イベントへ流すので unhandled
 * rejection でクラッシュはしない（現状その失敗は無通知。呼び出し側 UI で
 * `win.once("tauri://error", …)` を listen する余地あり）。
 */
export async function openPanelWindow(panelId: PanelId): Promise<void> {
  if (!isTauri()) return;
  // 別窓対象外（editor／未知 panel）は no-op。これが無いと生成窓は
  // target=null でアプリ全体を描く複製窓になる（呼び出し側 UI も項目を
  // 隠すが、ここを最終防衛線にして経路を問わず複製窓を不可能にする）。
  if (!canOpenPanelWindow(panelId)) return;
  const label = panelWindowLabel(panelId);
  const existing = await getWebviewWindowByLabel(label);
  if (existing) {
    await existing.setFocus();
    return;
  }
  const { label: l, ...options } = buildPanelWindowOptions(panelId);
  await createWebviewWindow(l, options);
}

/**
 * そのパネルの別窓が存在すればウィンドウハンドルを返す（無ければ null）。
 * ルーティング判定（別窓があるか）や focus に使う。非 Tauri は null。
 */
export async function getPanelWindowHandle(
  panelId: PanelId,
): Promise<AppWindowHandle | null> {
  if (!isTauri()) return null;
  return getWebviewWindowByLabel(panelWindowLabel(panelId));
}
