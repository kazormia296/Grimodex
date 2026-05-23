import type { BrowserMock } from "./browser-mock";
import { enqueueIpc } from "./ipcQueue";
export type { BrowserMock };

/** Check at call time, not module-load time, to avoid race with Tauri bridge injection. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const IPC_TIMEOUT_MS = 10_000;

/** AI inference can take several minutes on local hardware (Ollama etc.) */
const AI_IPC_TIMEOUT_MS = 300_000; // 5 minutes

const SLOW_COMMANDS = new Set([
  "send_chat_message",
  "send_chat_message_stream",
  /** CLI は invoke が子プロセス終了までブロックするため HTTP ストリームと同様に長めのタイムアウト */
  "send_cli_chat_stream",
  "send_agent_message",
  "send_inline_ai_stream",
  "abort_inline_ai_stream",
  "test_ai_connection",
  "list_ai_models",
  "list_cli_models",
  "start_post_effect_run",
  /** 全 scene の再インデックスは scene 数 × Embedder 推論時間で分単位になりうる */
  "semantic_reindex_all",
  /** 中規模プロジェクトでは Aho-Corasick 構築に 10 秒超かかることがある */
  "codex_rebuild_matcher",
]);

let browserMock: BrowserMock | null = null;
let browserMockReady: Promise<BrowserMock> | null = null;

function getBrowserMock(): Promise<BrowserMock> {
  if (browserMock) return Promise.resolve(browserMock);
  if (!browserMockReady) {
    browserMockReady = import("./browser-mock").then(async (m) => {
      browserMock = await m.createBrowserMock();
      return browserMock;
    });
  }
  return browserMockReady;
}

/**
 * Listen to a Tauri event (or browser CustomEvent in non-Tauri env).
 * Returns an unlisten function.
 */
export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (isTauri()) {
    const { listen: tauriListen } = await import("@tauri-apps/api/event");
    return tauriListen<T>(event, (e) => handler(e.payload));
  }
  // Browser fallback: use CustomEvent
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<T>).detail;
    handler(detail);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri()) {
    console.debug(`[tauri] invoke: ${cmd} (native)`);
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    const ms = SLOW_COMMANDS.has(cmd) ? AI_IPC_TIMEOUT_MS : IPC_TIMEOUT_MS;
    return enqueueIpc(cmd, () => tauriInvoke<T>(cmd, args), ms);
  }
  const mock = await getBrowserMock();
  return mock.invoke<T>(cmd, args);
}
