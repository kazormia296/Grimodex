import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { debugLog, errorDetail } from "./lib/debugLog";
import "./lib/i18n";
import "./index.css";

window.addEventListener("unhandledrejection", (event) => {
  debugLog.error("Global", "unhandled rejection", errorDetail(event.reason));
});

// デフォルトのコンテキストメニューを無効化
document.addEventListener("contextmenu", (e) => e.preventDefault());

// ブラウザデフォルトショートカットを無効化
// Ctrl+R: リロード, Ctrl+P: 印刷, Ctrl+F: ページ内検索
// F5: リロード, F3: 検索
document.addEventListener("keydown", (e) => {
  const blocked =
    (e.ctrlKey && ["r", "p", "f"].includes(e.key.toLowerCase())) ||
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
