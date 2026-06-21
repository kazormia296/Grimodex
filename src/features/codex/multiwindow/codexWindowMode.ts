/**
 * 別フローティングウィンドウ（Codex 編集面）かどうかの判定。
 *
 * 窓は URL `index.html?window=codex` で生成される（capability label は
 * CODEX_WINDOW_LABEL）。判定は URL クエリを正本にする＝Tauri ランタイム非依存で
 * happy-dom テストでも検証できる。label はあくまで OS / capability 側の識別子。
 */

export const CODEX_WINDOW_LABEL = "codex-window";

export type WindowMode = "main" | "codex";

/** location.search 相当の文字列から窓モードを決める純関数。 */
export function parseWindowMode(search: string): WindowMode {
  // URLSearchParams は先頭の "?" を自前で剥がす（"" / "?" は空集合）。
  const params = new URLSearchParams(search);
  return params.get("window") === "codex" ? "codex" : "main";
}

/** 現在の窓のモード。ブラウザ外（SSR/テスト）では "main"。 */
export function getWindowMode(): WindowMode {
  if (typeof window === "undefined") return "main";
  return parseWindowMode(window.location.search);
}

export function isCodexWindow(): boolean {
  return getWindowMode() === "codex";
}
