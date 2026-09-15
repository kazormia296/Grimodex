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

const D2A_EGRESS_DENIED_MARKER = "D2A_EGRESS_DENIED:";

/**
 * D2a denials may be wrapped by Drizzle's query error before reaching a
 * feature store. Walk the standard `cause` chain so expected restricted
 * optional reads can degrade without being reported as runtime failures.
 */
export function isD2aEgressDenied(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && current !== undefined) {
    if (typeof current === "string") {
      return current.includes(D2A_EGRESS_DENIED_MARKER);
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      "message" in current &&
      String(
        (current as { readonly message?: unknown }).message ?? "",
      ).includes(D2A_EGRESS_DENIED_MARKER)
    ) {
      return true;
    }
    current =
      "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return false;
}

/** AI inference can take several minutes on local hardware (Ollama etc.) */
const AI_IPC_TIMEOUT_MS = 300_000; // 5 minutes

export type IpcInvokeErrorCode =
  | "WORKSPACE_SWITCHING"
  | "NO_WORKSPACE_OPEN"
  | "RERANKER_BUSY"
  | "IPC_UNIMPLEMENTED"
  | "IPC_BACKEND_UNAVAILABLE"
  | "IPC_SECRETS_UNAVAILABLE"
  | "IPC_READ_CANCELLED"
  | "IPC_DERIVED_CANCELLED"
  | "IPC_MUTATION_CANCELLED"
  | "IPC_TIMEOUT"
  | "UNKNOWN";

export type IpcInvokeOutcome = "failed" | "unknown";

interface IpcInvokeFailureInfo {
  code: IpcInvokeErrorCode;
  message: string;
  retryable: boolean;
  outcome: IpcInvokeOutcome;
  details?: Record<string, unknown>;
}

/**
 * Typed error for new callers. `message` and `toString()` retain the legacy
 * wire text so existing marker checks continue to work during migration.
 */
export class IpcInvokeError extends Error {
  readonly code: IpcInvokeErrorCode;
  readonly retryable: boolean;
  readonly outcome: IpcInvokeOutcome;
  readonly details?: Record<string, unknown>;
  readonly command: string;

  constructor(command: string, info: IpcInvokeFailureInfo, cause?: unknown) {
    super(info.message);
    this.name = "IpcInvokeError";
    this.command = command;
    this.code = info.code;
    this.retryable = info.retryable;
    this.outcome = info.outcome;
    this.details = info.details;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause,
      });
    }
  }

  override toString(): string {
    return this.message;
  }
}

/**
 * Read/derived work rejected by a destructive lifecycle is cancellation, not
 * an application failure. Callers that own optional/background projections
 * use this guard to avoid surfacing expected scope teardown as an error.
 */
export function isIpcLifecycleCancellation(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current !== null && typeof current === "object") {
    if (seen.has(current)) return false;
    seen.add(current);
    // Lazy renderer chunks can carry the same typed IPC error through an
    // adapter boundary with a different constructor identity. The canonical
    // code remains the stable contract across those boundaries.
    const code =
      "code" in current
        ? (current as { readonly code?: unknown }).code
        : undefined;
    if (
      code === "IPC_READ_CANCELLED" ||
      code === "IPC_DERIVED_CANCELLED" ||
      code === "IPC_MUTATION_CANCELLED"
    ) {
      return true;
    }
    current =
      "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function classifyLegacyIpcError(message: string): IpcInvokeFailureInfo {
  const base = { message, outcome: "failed" as const };
  if (message.includes("WORKSPACE_SWITCHING")) {
    return { ...base, code: "WORKSPACE_SWITCHING", retryable: true };
  }
  if (/No workspace is open/i.test(message)) {
    return { ...base, code: "NO_WORKSPACE_OPEN", retryable: true };
  }
  if (message.includes("RERANKER_BUSY:")) {
    return { ...base, code: "RERANKER_BUSY", retryable: true };
  }
  if (message.includes("IPC_UNIMPLEMENTED:")) {
    return { ...base, code: "IPC_UNIMPLEMENTED", retryable: false };
  }
  if (message.includes("IPC_BACKEND_UNAVAILABLE:")) {
    return { ...base, code: "IPC_BACKEND_UNAVAILABLE", retryable: false };
  }
  if (message.includes("IPC_SECRETS_UNAVAILABLE")) {
    return { ...base, code: "IPC_SECRETS_UNAVAILABLE", retryable: false };
  }
  if (message.includes("IPC_READ_CANCELLED:")) {
    return { ...base, code: "IPC_READ_CANCELLED", retryable: true };
  }
  if (message.includes("IPC_DERIVED_CANCELLED:")) {
    return { ...base, code: "IPC_DERIVED_CANCELLED", retryable: true };
  }
  if (message.includes("IPC_MUTATION_CANCELLED:")) {
    return { ...base, code: "IPC_MUTATION_CANCELLED", retryable: true };
  }
  return { ...base, code: "UNKNOWN", retryable: false };
}

function normalizeIpcFailure(command: string, error: unknown): unknown {
  if (error instanceof IpcInvokeError) return error;
  // lint_text's `{type,data}` rejection is an intentional Tauri compatibility
  // exception. Preserve object rejects rather than wrapping them in Error.
  if (
    error !== null &&
    typeof error === "object" &&
    !(error instanceof Error)
  ) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const timeout = /^IPC timeout after (\d+)ms: /.exec(message);
  if (timeout) {
    return new IpcInvokeError(
      command,
      {
        code: "IPC_TIMEOUT",
        message,
        retryable: false,
        // The native operation retains its queue slot and may still commit.
        // Retrying automatically could therefore duplicate a mutation.
        outcome: "unknown",
        details: { timeoutMs: Number(timeout[1]) },
      },
      error,
    );
  }
  return new IpcInvokeError(command, classifyLegacyIpcError(message), error);
}

/**
 * Caller-side timeout is safe only for commands verified to be read-only.
 * Mutating and unknown commands await their actual native result because a
 * timeout cannot cancel native work and retrying an unknown outcome can
 * duplicate a write or publish the wrong workspace authority.
 */
const READ_ONLY_COMMAND_TIMEOUTS = new Map<string, number>([
  ["get_global_settings", IPC_TIMEOUT_MS],
  ["narrative_extraction_capture_workspace_binding", IPC_TIMEOUT_MS],
  ["validate_workspace_path", IPC_TIMEOUT_MS],
  ["list_backups", IPC_TIMEOUT_MS],
  ["list_system_fonts", IPC_TIMEOUT_MS],
  ["foreshadow_load_anchors_for_scene", IPC_TIMEOUT_MS],
  ["list_annotations_for_scene", IPC_TIMEOUT_MS],
  ["fts_search", IPC_TIMEOUT_MS],
  ["nir1_evidence_qualify", IPC_TIMEOUT_MS],
  ["nir1_pack_context", IPC_TIMEOUT_MS],
  ["nir1_entity_relation_revision_read", IPC_TIMEOUT_MS],
  ["nir1_entity_relation_revision_read_current", IPC_TIMEOUT_MS],
  // These reads can legitimately include process/network startup or a model
  // cold-load, so retain the existing five-minute caller budget.
  ["detect_cli_binary", AI_IPC_TIMEOUT_MS],
  ["list_ai_models", AI_IPC_TIMEOUT_MS],
  ["list_cli_models", AI_IPC_TIMEOUT_MS],
  ["codex_app_list_models", AI_IPC_TIMEOUT_MS],
  ["semantic_search", AI_IPC_TIMEOUT_MS],
  ["semantic_reranker_shadow_score", AI_IPC_TIMEOUT_MS],
  ["codex_semantic_search", AI_IPC_TIMEOUT_MS],
  ["events_semantic_search", AI_IPC_TIMEOUT_MS],
  ["chat_message_search", AI_IPC_TIMEOUT_MS],
  ["segment_bunsetsu", AI_IPC_TIMEOUT_MS],
  ["extract_codex_entity_seeds", AI_IPC_TIMEOUT_MS],
  ["vivliostyle_detect", AI_IPC_TIMEOUT_MS],
]);

/**
 * Rebuildable semantic indexes are not manuscript authority. Rust pins every
 * request to the Database/cache epoch captured at command start, and its
 * content-hash checks make a late result safe. Keep these jobs in a bounded
 * background lane so a project backfill cannot occupy every native slot or
 * hold strict document quiescence open during exit/workspace switching.
 */
const DERIVED_INDEX_COMMANDS = new Set([
  "semantic_index_scene",
  "semantic_reindex_all",
  "codex_index_entry",
  "codex_reindex_all",
  "events_index_entry",
  "events_reindex_all",
  "chat_index_message",
  "chat_reindex_all",
  "related_scenes_begin",
  "related_scenes_continue",
]);

const AUDIT_EXPORT_READ_COMMANDS = new Set([
  "ai_audit_read_snapshot",
  "ai_audit_verify",
]);

function sqlCodeOnly(sql: string): string | null {
  let code = "";
  let index = 0;

  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];
    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") {
        index++;
      }
      code += " ";
      continue;
    }
    if (current === "/" && next === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      if (commentEnd < 0) return null;
      index = commentEnd + 2;
      code += " ";
      continue;
    }
    if (
      current === "'" ||
      current === '"' ||
      current === "`" ||
      current === "["
    ) {
      const closing = current === "[" ? "]" : current;
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== closing) {
          index++;
          continue;
        }
        if (sql[index + 1] === closing) {
          index += 2;
          continue;
        }
        index++;
        closed = true;
        break;
      }
      if (!closed) return null;
      code += " ";
      continue;
    }
    code += current;
    index++;
  }

  return code;
}

function isReadOnlyDbExecute(
  args: Record<string, unknown> | undefined,
): boolean {
  const sql = args?.sql;
  const method = args?.method;
  if (
    typeof sql !== "string" ||
    !["all", "get", "values"].includes(String(method))
  ) {
    return false;
  }
  const code = sqlCodeOnly(sql);
  if (code === null) return false;
  const normalized = code.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(normalized)) return false;
  return !/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|PRAGMA)\b/i.test(
    normalized,
  );
}

function callerTimeoutForCommand(
  command: string,
  args?: Record<string, unknown>,
): number | null {
  if (command === "db_execute" && isReadOnlyDbExecute(args)) {
    return IPC_TIMEOUT_MS;
  }
  return READ_ONLY_COMMAND_TIMEOUTS.get(command) ?? null;
}

function ipcCategoryForCommand(
  command: string,
  args?: Record<string, unknown>,
): "mutation" | "read" | "derived" {
  if (DERIVED_INDEX_COMMANDS.has(command)) return "derived";
  if (AUDIT_EXPORT_READ_COMMANDS.has(command)) return "read";
  return callerTimeoutForCommand(command, args) === null ? "mutation" : "read";
}

function relatedScenesPendingTicket(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const ir = (value as { readonly ir?: unknown }).ir;
  if (ir === null || typeof ir !== "object" || Array.isArray(ir)) return null;
  const pending = ir as {
    readonly status?: unknown;
    readonly operationTicket?: unknown;
  };
  return pending.status === "pending" &&
    typeof pending.operationTicket === "string" &&
    pending.operationTicket.trim().length > 0
    ? pending.operationTicket
    : null;
}

/**
 * A lifecycle can detach the renderer caller while Native finishes a begin
 * against its pinned scope. If that late result allocated a ticket, release it
 * through the normal mutation path because no feature session can bind it.
 */
function createRelatedScenesBeginLateResultCleanup() {
  const unset = Symbol("related-scenes-begin-result-unset");
  let result: unknown | typeof unset = unset;
  let lifecycleCancelled = false;
  let releaseStarted = false;

  const releaseIfOrphaned = () => {
    if (!lifecycleCancelled || result === unset || releaseStarted) return;
    const operationTicket = relatedScenesPendingTicket(result);
    if (operationTicket === null) return;
    releaseStarted = true;
    void invoke("related_scenes_release", { operationTicket }).catch(
      (error: unknown) => {
        console.warn(
          "[tauri] Late Related Scenes ticket release failed",
          error,
        );
      },
    );
  };

  return {
    observeResult(value: unknown): void {
      result = value;
      releaseIfOrphaned();
    },
    observeCallerFailure(error: unknown): void {
      if (!isIpcLifecycleCancellation(error)) return;
      lifecycleCancelled = true;
      releaseIfOrphaned();
    },
  };
}

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
      // Node-side integration tests seed protected domain rows through the
      // Drizzle fixture surface. Keep that fixture-only escape hatch scoped to
      // Vitest's lazy BrowserMock; production BrowserRuntime instances still
      // create their mock with the default fail-closed Writer Authority.
      const allowProtectedWriterTestFixtures =
        typeof process !== "undefined" && process.env?.NODE_ENV === "test";
      browserMock = await m.createBrowserMock({
        allowProtectedWriterTestFixtures,
      });
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
    const ms = callerTimeoutForCommand(cmd, args);
    try {
      return await enqueueIpc(
        cmd,
        () => tauriInvoke<T>(cmd, args),
        ms,
        ipcCategoryForCommand(cmd, args),
      );
    } catch (error) {
      throw normalizeIpcFailure(cmd, error);
    }
  }
  if (isElectron()) {
    console.debug(`[tauri] invoke: ${cmd} (electron)`);
    const bridge = electronBridge();
    const ms = callerTimeoutForCommand(cmd, args);
    const lateBeginCleanup =
      cmd === "related_scenes_begin"
        ? createRelatedScenesBeginLateResultCleanup()
        : null;
    try {
      return await enqueueIpc(
        cmd,
        async () => {
          const envelope = await bridge.invoke<T>(cmd, args);
          if (!envelope.ok) {
            // lint_text の LintError は Tauri が object（{type,data}）で
            // serialize する唯一のコマンド。互換性のため raw object のまま。
            if (envelope.errorValue !== undefined) {
              throw envelope.errorValue;
            }
            const info = envelope.errorInfo
              ? {
                  code: envelope.errorInfo.code,
                  // The legacy wire remains the displayed/stringified value.
                  // `errorInfo.message` is expected to match but must not
                  // silently change compatibility behavior if it drifts.
                  message: envelope.error,
                  retryable: envelope.errorInfo.retryable,
                  outcome: envelope.errorInfo.outcome,
                  details: envelope.errorInfo.details,
                }
              : classifyLegacyIpcError(envelope.error);
            throw new IpcInvokeError(cmd, info);
          }
          lateBeginCleanup?.observeResult(envelope.value);
          return envelope.value;
        },
        ms,
        ipcCategoryForCommand(cmd, args),
      );
    } catch (error) {
      const normalized = normalizeIpcFailure(cmd, error);
      lateBeginCleanup?.observeCallerFailure(normalized);
      throw normalized;
    }
  }
  const ms = callerTimeoutForCommand(cmd, args);
  try {
    return await enqueueIpc(
      cmd,
      async () => {
        const mock = await getBrowserMock();
        return mock.invoke<T>(cmd, args);
      },
      ms,
      ipcCategoryForCommand(cmd, args),
    );
  } catch (error) {
    throw normalizeIpcFailure(cmd, error);
  }
}
