/**
 * 実行エンジンがフォームコントロール (<button> 等) の縦書き writing-mode を
 * サポートするかを DOM probe で判定する。
 *
 * WebKitGTK は機能フラグ VerticalFormControls（既定 OFF）で拒否し、その場合
 * button の computed writing-mode が horizontal-tb へ強制される。Rust 側
 * (src-tauri/src/webkit_features.rs) がフラグを有効化できていれば true。
 * Chromium (M119+) / WKWebView (17.4+) は常に true。
 *
 * App 起動時に isWebKitGtk() 環境でこの結果を <html data-vfc="on"> として
 * 反映し、index.css の Beat chrome 横書き島フォールバックのゲートに使う
 * （probe が false の環境だけ島ルールが生きる）。
 */
export function supportsVerticalFormControls(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  const probe = document.createElement("button");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.writingMode = "vertical-rl";
  document.body.appendChild(probe);
  const supported = getComputedStyle(probe).writingMode === "vertical-rl";
  probe.remove();
  return supported;
}
