import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { debugLog, errorDetail } from "./lib/debugLog";
import { matchesMod } from "./lib/platform";
import "./lib/i18n";
import "./lib/perfLog";
import "./index.css";
// 同梱フォント: Noto Serif JP (OFL-1.1)。本文デフォルト書体。fontsource が
// subset 済み woff2 を提供し、Vite が build 時にバンドルする ('self' asset)。
// 日本語 + Latin、Regular(400)/Bold(700)。@font-face family は "Noto Serif JP"。
import "@fontsource/noto-serif-jp/japanese-400.css";
import "@fontsource/noto-serif-jp/japanese-700.css";
import "@fontsource/noto-serif-jp/latin-400.css";
import "@fontsource/noto-serif-jp/latin-700.css";
// 同梱フォント: M PLUS 1 (OFL-1.1)。UI デフォルト書体 (--ui-font 経由)。
import "@fontsource/m-plus-1/japanese-400.css";
import "@fontsource/m-plus-1/japanese-700.css";
import "@fontsource/m-plus-1/latin-400.css";
import "@fontsource/m-plus-1/latin-700.css";
// 同梱フォント: LINE Seed JP (OFL-1.1)。デフォルトではなく追加の選択肢。
import "@fontsource/line-seed-jp/japanese-400.css";
import "@fontsource/line-seed-jp/japanese-700.css";
import "@fontsource/line-seed-jp/latin-400.css";
import "@fontsource/line-seed-jp/latin-700.css";
// 同梱フォント: Noto Sans JP (OFL-1.1)。デフォルトではなく追加の選択肢。
import "@fontsource/noto-sans-jp/japanese-400.css";
import "@fontsource/noto-sans-jp/japanese-700.css";
import "@fontsource/noto-sans-jp/latin-400.css";
import "@fontsource/noto-sans-jp/latin-700.css";
import { ensureTokenizer } from "./features/chat/contextBuilder";

window.addEventListener("unhandledrejection", (event) => {
  debugLog.error("Global", "unhandled rejection", errorDetail(event.reason));
});

// デフォルトのコンテキストメニューを無効化
document.addEventListener("contextmenu", (e) => e.preventDefault());

// ブラウザデフォルトショートカットを無効化
// Ctrl+R: リロード, Ctrl+P: 印刷, Ctrl+F: ページ内検索
// F5: リロード, F3: 検索
// Shift/Alt 併用は自前ショートカット (Ctrl+Shift+F = CommandCenter バー等) に
// 譲るため block 対象外。macOS では primary modifier が ⌘ なので matchesMod で
// ⌘R/⌘P/⌘F も同様に block する。
document.addEventListener("keydown", (e) => {
  const blocked =
    (matchesMod(e) &&
      !e.shiftKey &&
      !e.altKey &&
      ["r", "p", "f"].includes(e.key.toLowerCase())) ||
    e.key === "F5" ||
    e.key === "F3";
  if (blocked) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// Warm up tiktoken WASM during idle so the first chat-flow `await
// ensureTokenizer()` returns immediately instead of paying ~30ms init cost
// on the click critical path.
const __idle =
  (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
    .requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));
__idle(() => {
  void ensureTokenizer().catch(() => {
    // Failures are already logged by ensureTokenizer itself.
  });
});
