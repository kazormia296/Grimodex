import { CODEX_WINDOW_LABEL } from "./codexWindowMode";

/**
 * WebviewWindow 生成オプション（純データ）。Tauri 依存を切り離してテスト可能に
 * するため、生成本体（openCodexWindow）とは分離する。
 *
 * transparent / decorations:false は現 UI が glass shell 前提のため必須
 * （指定しないと枠付き不透明窓になり崩れる。検討メモ §4.1）。
 */
export interface CodexWindowOptions {
  label: string;
  url: string;
  transparent: boolean;
  decorations: boolean;
  width: number;
  height: number;
  title: string;
}

export function buildCodexWindowOptions(): CodexWindowOptions {
  return {
    label: CODEX_WINDOW_LABEL,
    // panel-only マウントへ分岐させるクエリ（codexWindowMode.parseWindowMode）。
    url: "index.html?window=codex",
    transparent: true,
    decorations: false,
    // サブモニタで参照しやすい縦長の初期サイズ。
    width: 480,
    height: 900,
    title: "Codex",
  };
}
