import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { debugLog, errorDetail } from "./lib/debugLog";
import "./lib/i18n";
import "./lib/perfLog";
import "./index.css";
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
// 譲るため block 対象外。
document.addEventListener("keydown", (e) => {
  const blocked =
    (e.ctrlKey &&
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
