import type { BrowserMock } from "./browser-mock";
import { enqueueIpc } from "./ipcQueue";
import { electronBridge, isElectron } from "./shell";
export type { BrowserMock };

/** Check at call time, not module-load time, to avoid race with Tauri bridge injection. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Electron シェル判定（設計書 §3.4）。実体は ./shell.ts（既存テストの
 * 部分 vi.mock("@/lib/tauri") factory と干渉させないため）。
 * 分岐順は isTauri → isElectron → browser-mock。
 */
export { isElectron } from "./shell";

const IPC_TIMEOUT_MS = 10_000;

/** AI inference can take several minutes on local hardware (Ollama etc.) */
const AI_IPC_TIMEOUT_MS = 300_000; // 5 minutes

const SLOW_COMMANDS = new Set([
  "send_chat_message",
  "send_chat_message_stream",
  /** CLI は invoke が子プロセス終了までブロックするため HTTP ストリームと同様に長めのタイムアウト */
  "send_cli_chat_stream",
  /** GUI起動時のPATH補完はlogin shell / toolchain探索を行い、内部timeoutが10秒近くなる。 */
  "detect_cli_binary",
  /** 手入力pathはElectron mainのnative authorization応答を待つ。 */
  "test_cli_connection",
  "send_agent_message",
  "send_inline_ai_stream",
  "abort_inline_ai_stream",
  "test_ai_connection",
  /** Polar clientのHTTP timeoutは15s。外側10sで先にrejectするとnativeだけが
   * license.jsonを後から更新し、再試行でactivation枠を重複消費しうる。 */
  "activate_license",
  "revalidate_license",
  "deactivate_license",
  "list_ai_models",
  "list_cli_models",
  /** Codex App Serverのlazy起動・モデル一覧・Turn開始。 */
  "codex_app_test_connection",
  "codex_app_list_models",
  "codex_app_start_turn",
  "codex_app_interrupt_turn",
  "codex_app_archive_session_thread",
  "codex_app_set_thread_name",
  "start_post_effect_run",
  /** 全 scene の再インデックスは scene 数 × Embedder 推論時間で分単位になりうる */
  "semantic_reindex_all",
  /** embedder コールド時 (初回 ONNX ロード) は 1 scene でも 10s を超えうる。
   *  reindex_all だけ入っていた非対称の解消 (semantic-index-db-lock #2)。 */
  "semantic_index_scene",
  "semantic_search",
  /** codex も同様: 全件 back-index は分単位、単件 index も embedder コールド時 >10s。
   *  semantic_* と対称に長めのタイムアウトを与える (段階3c)。 */
  "codex_reindex_all",
  "codex_index_entry",
  "codex_semantic_search",
  /** Chronicle / chat semantic index and query commands share the same ONNX cold-load
   *  and full-project reindex costs as scene/codex. */
  "events_index_entry",
  "events_semantic_search",
  "events_reindex_all",
  "chat_index_message",
  "chat_message_search",
  "chat_reindex_all",
  /** 中規模プロジェクトでは Aho-Corasick 構築に 10 秒超かかることがある */
  "codex_rebuild_matcher",
  /** 初回呼び出しは lindera UniDic 埋め込み辞書のコールドロード（OnceLock、
   *  morph.rs）で低速機だと 10s を超えうる。reject すると文節リオーダーが
   *  文粒度フォールバックに退化するため長めのタイムアウトを与える。 */
  "segment_bunsetsu",
  /** ネイティブ保存ダイアログを開いている間 invoke がブロックする。ユーザーが
   *  保存先を選ぶまで分単位かかりうるので 10s では reject されてしまう。 */
  "export_save_text",
  "export_save_bytes",
  /** import も同様: Rust 側でファイル/フォルダ選択ダイアログを開いている間
   *  invoke がブロックするため、export_save_* と同じく長めのタイムアウトを与える。 */
  "import_open_text_file",
  "import_pick_folder_markdown",
  /** detect はログインシェル起動を伴う PATH 解決で 10s を超えうる。save は
   *  export_save_* と同じく保存ダイアログで invoke がブロックする。
   *  (vivliostyle_build は即 runId を返す fire-and-forget なので不要) */
  "vivliostyle_detect",
  "vivliostyle_save_output",
  /** Electronでは手入力pathのnative authorization応答を待ってからpreviewをspawnする。 */
  "vivliostyle_preview_start",
  /** updater の network check / package download は 10s を超えうる。 */
  "updater_check",
  "updater_download",
  /** M3 で async 化した長時間 DB コマンド群。JS 側 10s タイムアウトだと
   *  「Rust 側は実行継続しているのに失敗扱い → 再クリックで多重実行」になる。
   *  FTS 全再構築/修復は分単位、open/seed は migrate + VACUUM INTO を含み、
   *  extract は全シーン形態素解析。db_execute_batch は毎オートセーブの spans
   *  batch にも使われるため入れない (300s にすると真のハング検出が遅れる。
   *  pre-M3 も 10s で運用できていた)。 */
  "fts_rebuild",
  "fts_rebuild_en",
  "fts_optimize",
  "repair_integrity",
  "seed_sample_workspace",
  "open_workspace",
  "extract_codex_candidates",
  /** バックアップ復元は 復元前の安全退避 (VACUUM INTO) + 接続クローズ待ち +
   *  ファイル置換 + 再オープン (migrate) を含むため、大きな DB では 10s を
   *  超えうる。open_workspace と同様に長めのタイムアウトを与える
   *  (backup restore Phase 1)。 */
  "restore_backup",
]);

let browserMock: BrowserMock | null = null;
let browserMockReady: Promise<BrowserMock> | null = null;

export function installBrowserMock(mock: BrowserMock): void {
  browserMock = mock;
  browserMockReady = Promise.resolve(mock);
}

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
  if (isElectron()) {
    // bridge.listen は同期 unlisten 返し（§5.4 — ここで Promise 化）。
    // allowlist（electron/shared/ipcContract.ts の列挙制）外のチャネルは
    // preload が throw し、この async 関数の reject になる。
    return electronBridge().listen(event, (payload) => {
      handler(payload as T);
    });
  }
  // Browser fallback: use CustomEvent
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<T>).detail;
    handler(detail);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}

/**
 * Emit a Tauri event to all windows (or a browser CustomEvent in non-Tauri env).
 * Tauri v2 の emit は全ウィンドウへ配信される（external_mount/watch.rs と同契約）。
 * ブラウザ fallback は同一窓内のみ（ブラウザにマルチウインドウ配信は無い）。
 */
export async function emit<T = unknown>(
  event: string,
  payload?: T,
): Promise<void> {
  if (isTauri()) {
    const { emit: tauriEmit } = await import("@tauri-apps/api/event");
    await tauriEmit(event, payload);
    return;
  }
  if (isElectron()) {
    // main が allowlist 検証のうえ全窓へ broadcast（自己配信含む =
    // Tauri v2 の emit 契約と同じ。§7.1）。
    await electronBridge().emit(event, payload);
    return;
  }
  window.dispatchEvent(new CustomEvent(event, { detail: payload }));
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
  if (isElectron()) {
    console.debug(`[tauri] invoke: ${cmd} (electron)`);
    const bridge = electronBridge();
    const ms = SLOW_COMMANDS.has(cmd) ? AI_IPC_TIMEOUT_MS : IPC_TIMEOUT_MS;
    return enqueueIpc(
      cmd,
      async () => {
        const envelope = await bridge.invoke<T>(cmd, args);
        if (!envelope.ok) {
          // Tauri の invoke は reject 値が生文字列（AppError の文字列
          // serialize）。envelope をここで解封して同一ワイヤにする —
          // `WORKSPACE_SWITCHING` / `No workspace is open` 等のマーカー
          // 部分一致判定（FE 126 箇所）の保存が目的（設計書 §5.2）。
          // 例外: lint_text の LintError は Tauri が object（{type,data}）で
          // serialize する唯一のコマンドで、errorValue に載って届く
          // （formatLintError の分岐を保存）。
          throw envelope.errorValue !== undefined
            ? envelope.errorValue
            : envelope.error;
        }
        return envelope.value;
      },
      ms,
    );
  }
  const mock = await getBrowserMock();
  return mock.invoke<T>(cmd, args);
}
