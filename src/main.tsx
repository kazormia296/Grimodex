import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { debugLog, errorDetail } from "./lib/debugLog";
import { matchesMod } from "./lib/platform";
import "./lib/i18n";
import "./lib/perfLog";
import "./lib/imeLog";
import "./index.css";
import "./features/editor/stickies/editorStickyCard.css";
import { installSuppressSystemMenuOnAlt } from "./lib/suppressSystemMenuOnAlt";
import { isElectron, isTauri, listen } from "./lib/tauri";
import { installDefaultEditorNavigation } from "./features/editor/editorNavigationPorts";
import { RuntimeCapabilitiesProvider } from "./runtime/runtimeCapabilitiesContext";
import { AiDataConsentGate } from "./features/ai-policy/AiDataConsentGate";
import { requestWebEditorHandoffImport } from "./features/import/webEditorHandoffRequest";
import { installSelectedBundledFontLoading } from "./features/settings/bundledFontLoader";

performance.mark("grimodex:renderer-bootstrap");

installDefaultEditorNavigation();
installSelectedBundledFontLoading();

// Electron シェル判定フラグ。S6 の drag-region CSS
// （html[data-shell="electron"] セレクタ、設計書 §6.2）がこの属性を条件に
// data-tauri-drag-region → -webkit-app-region を有効化する。
if (isElectron()) {
  document.documentElement.dataset.shell = "electron";
}
document.documentElement.dataset.runtimeTarget = isElectron()
  ? "electron"
  : "web";

// Install this listener during module evaluation, before Electron's
// did-finish-load signal. App may mount a little later; the request module
// retains one pending UI request until the root subscribes.
if (isElectron()) {
  void listen<{ kind: string }>("web-editor-handoff:requested", (payload) => {
    if (payload?.kind === "web-editor-handoff") {
      requestWebEditorHandoffImport();
    }
  }).catch((error) => {
    debugLog.error(
      "WebEditorHandoff",
      "failed to install desktop handoff listener",
      errorDetail(error),
    );
  });
}

window.addEventListener("unhandledrejection", (event) => {
  debugLog.error("Global", "unhandled rejection", errorDetail(event.reason));
});

if (isElectron()) {
  // Desktop-only shell behavior. Browser/PWA keeps native context menus and
  // reload/print/find shortcuts available.
  document.addEventListener("contextmenu", (e) => e.preventDefault());
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
  installSuppressSystemMenuOnAlt();
}

const rootElement = document.getElementById("root") as HTMLElement;

function renderApplication(): void {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <RuntimeCapabilitiesProvider target={isElectron() ? "electron" : "web"}>
          <App />
          <AiDataConsentGate />
        </RuntimeCapabilitiesProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );

  requestAnimationFrame(() => {
    performance.mark("grimodex:renderer-first-frame");
  });

  if (
    import.meta.env.PROD &&
    !isElectron() &&
    !isTauri() &&
    "serviceWorker" in navigator
  ) {
    void navigator.serviceWorker.register("/editor-sw.js");
  }
}

function renderBrowserBootstrapFailure(error: unknown): void {
  debugLog.error("BrowserRuntime", "bootstrap failed", errorDetail(error));
  const container = document.createElement("main");
  container.setAttribute("role", "alert");
  container.style.padding = "2rem";
  container.style.fontFamily = "var(--ui-font, sans-serif)";
  const heading = document.createElement("h1");
  heading.textContent = "Grimodex Editor を起動できませんでした";
  const detail = document.createElement("p");
  detail.textContent =
    error instanceof Error ? error.message : "ブラウザーの初期化に失敗しました";
  container.append(heading, detail);
  rootElement.replaceChildren(container);
}

function renderBrowserPersistenceFailure(
  message: string,
  error: unknown,
): void {
  debugLog.error("BrowserRuntime", "persistence failed", errorDetail(error));
  if (document.getElementById("grimodex-browser-persistence-error")) return;

  const container = document.createElement("aside");
  container.id = "grimodex-browser-persistence-error";
  container.setAttribute("role", "alert");
  container.setAttribute("aria-live", "assertive");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeContent: "center",
    gap: "0.75rem",
    padding: "2rem",
    background: "rgba(15, 12, 20, 0.96)",
    color: "#f8f7fa",
    fontFamily: "var(--ui-font, sans-serif)",
  });
  const heading = document.createElement("h1");
  heading.textContent = "Grimodex Editor の保存を停止しました";
  const detail = document.createElement("p");
  detail.style.maxWidth = "42rem";
  detail.textContent = message;
  const reload = document.createElement("button");
  reload.type = "button";
  reload.textContent = "ページを再読み込み";
  Object.assign(reload.style, {
    justifySelf: "start",
    padding: "0.625rem 1rem",
    border: "1px solid #7c3aed",
    borderRadius: "0.5rem",
    background: "#7c3aed",
    color: "white",
    cursor: "pointer",
  });
  reload.addEventListener("click", () => window.location.reload());
  container.append(heading, detail, reload);
  document.body.append(container);
}

async function bootstrapRenderer(): Promise<void> {
  // Native shells keep their existing synchronous bootstrap. Web Editor
  // must restore and install BrowserMock before App can make its first invoke.
  if (!isElectron() && !isTauri()) {
    const {
      assertWebEditorDurability,
      initializeBrowserRuntime,
      browserPersistenceFailureMessage,
    } = await import("./lib/browserRuntime");
    const browserRuntime = await initializeBrowserRuntime({
      onPersistenceError: (error) =>
        renderBrowserPersistenceFailure(
          browserPersistenceFailureMessage(error),
          error,
        ),
    });
    try {
      assertWebEditorDurability(browserRuntime.durability);
    } catch (error) {
      await browserRuntime.dispose();
      throw error;
    }
    const { installHostedEditorRuntime } =
      await import("./features/hosted-editor/hostedEditorRuntime");
    installHostedEditorRuntime(browserRuntime);
  }
  renderApplication();
}

void bootstrapRenderer().catch(renderBrowserBootstrapFailure);
