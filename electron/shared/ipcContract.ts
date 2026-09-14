/**
 * typed IPC ブリッジの契約実体（設計書 §5.2 / §5.4、Phase 2 S4）。
 *
 * - **envelope 方式**: Electron の `ipcMain.handle` の throw は
 *   `"Error invoking remote method …"` プレフィックスでワイヤを汚すため、
 *   main は決して throw せず `{ ok, value | error }` を resolve する。
 *   renderer 側（src/lib/tauri.ts の electron 分岐、S5）が typed
 *   `IpcInvokeError` に解封する。`message` / `toString()` は旧 `error`
 *   文字列を維持し、`WORKSPACE_SWITCHING` 等の既存部分一致判定を保存する。
 * - **コマンド表**: Phase 2 の napi 垂直スライス 12 コマンドを起点に、Phase 3 の
 *   バッチごとに段階拡張する。引数アダプタ（Tauri の camelCase→snake_case
 *   自動変換の写像）はコマンドごとに明示する。この表が実装済みコマンド写像の
 *   正本になる（全145コマンドの静的棚卸し正本は docs のコマンド台帳）。
 * - **イベント allowlist**: 前方一致ではなく列挙制。listen は全イベントを
 *   受け付けるが、emit / backend 配信は送信元別の allowlist で制限する（§5.4）。
 *
 * このモジュールは main / preload の両方にバンドルされるため、electron にも
 * Node 組み込みにも依存しない純粋モジュールに保つ（vitest.electron.config.ts
 * の node 環境単体テスト対象）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// envelope
// ─────────────────────────────────────────────────────────────────────────────

export type IpcErrorCode =
  | "WORKSPACE_SWITCHING"
  | "WORKSPACE_SAFE_MODE"
  | "NO_WORKSPACE_OPEN"
  | "RERANKER_BUSY"
  | "IPC_UNIMPLEMENTED"
  | "IPC_BACKEND_UNAVAILABLE"
  | "IPC_SECRETS_UNAVAILABLE"
  | "IPC_DERIVED_CANCELLED"
  | "UNKNOWN";

export type IpcErrorOutcome = "failed" | "unknown";

export interface IpcErrorInfo {
  code: IpcErrorCode;
  message: string;
  retryable: boolean;
  /**
   * `unknown` means the caller stopped waiting but the native operation may
   * still complete. Main-process failures are always `failed`; renderer-side
   * IPC timeouts use `unknown`.
   */
  outcome: IpcErrorOutcome;
  details?: Record<string, unknown>;
}

export type Envelope<T = unknown> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /** Typed wire for new callers; `error` remains for legacy substring checks. */
      errorInfo?: IpcErrorInfo;
      /**
       * Tauri がエラーを **object** で serialize するコマンド（現状 lint_text の
       * `LintError` = `{type, data}` のみ）の reject 値。renderer 側の解封は
       * `errorValue` は raw object のまま throw する — FE `formatLintError`
       * の `{type, data}` 分岐を保存するため（§5.2 の例外規定）。
       */
      errorValue?: unknown;
    };

export type RecoveryCandidateKind =
  | "automatic-backup"
  | "manual-backup"
  | "migration-snapshot";

export type RecoveryChecksumStatus = "verified" | "unverified" | "invalid";

export interface RecoveryCandidate {
  id: string;
  kind: RecoveryCandidateKind;
  createdAt: string;
  schemaVersion: number | null;
  appVersion: string | null;
  sizeBytes: number;
  checksumStatus: RecoveryChecksumStatus;
}

export interface MigrationReceipt {
  fromSchema: number;
  toSchema: number;
  receiptPath: string;
  recovered: boolean;
  errorCode?: string;
}

export interface OpenWorkspacePayload {
  name: string;
  isExisting: boolean;
  workspaceId: string;
}

export type WorkspaceOpenOutcome =
  | { status: "ready"; workspace: OpenWorkspacePayload }
  | {
      status: "migrated";
      workspace: OpenWorkspacePayload;
      migration: MigrationReceipt;
    }
  | {
      status: "recovery-required";
      reason: string;
      errorCode: string;
      snapshotId?: string;
      candidates: RecoveryCandidate[];
    }
  | {
      status: "safe-mode";
      reason: string;
      candidates: RecoveryCandidate[];
    };

/**
 * dispatchInvoke の catch に「object reject へ復元せよ」と伝えるためのラッパー。
 * `message` には人間可読な文字列（= error フィールド）を残す。
 */
export class WireErrorValue extends Error {
  constructor(
    public readonly value: unknown,
    message: string,
  ) {
    super(message);
    this.name = "WireErrorValue";
  }
}

/**
 * 未知コマンドの安定マーカー（§4.3）。renderer 側の debugLog 集計
 * （A6 fail-soft 監査 / Phase 3 の優先順位付け実測データ）が前方一致で拾う。
 */
export const IPC_UNIMPLEMENTED_MARKER = "IPC_UNIMPLEMENTED:";

/** napi Backend (.node) のロードに失敗した状態で napi コマンドを呼んだ場合。 */
export const IPC_BACKEND_UNAVAILABLE_MARKER = "IPC_BACKEND_UNAVAILABLE:";

/** A CLI subprocess may not start without a durable audit dispatch proof. */
export const AI_AUDIT_DISPATCH_PRECONDITION_FAILED_MARKER =
  "AI_AUDIT_DISPATCH_PRECONDITION_FAILED:";

export function unimplementedError(cmd: string): string {
  return `${IPC_UNIMPLEMENTED_MARKER} ${cmd}`;
}

/**
 * reject 文字列への正規化。`Error` は message のみ（`String(err)` だと
 * `"Error: "` プレフィックスが乗りワイヤを汚す）。napi の `napi::Error` は
 * `AppError` の Display（`{e:#}` 整形済み anyhow 文字列）が message に
 * そのまま入っているので、これで Tauri ワイヤと同形になる。
 */
export function toErrorString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : String(e);
}

/**
 * Derive typed information only for stable, public error markers. Unknown
 * backend prose remains on the legacy wire and is normalized by the renderer
 * to `UNKNOWN` without guessing from unstable wording.
 */
export function classifyKnownIpcError(
  message: string,
): IpcErrorInfo | undefined {
  const base = {
    message,
    outcome: "failed" as const,
  };
  if (message.includes("WORKSPACE_SWITCHING")) {
    return { ...base, code: "WORKSPACE_SWITCHING", retryable: true };
  }
  if (message.includes("WORKSPACE_SAFE_MODE")) {
    return { ...base, code: "WORKSPACE_SAFE_MODE", retryable: false };
  }
  if (/No workspace is open/i.test(message)) {
    return { ...base, code: "NO_WORKSPACE_OPEN", retryable: true };
  }
  if (message.includes("RERANKER_BUSY:")) {
    return { ...base, code: "RERANKER_BUSY", retryable: true };
  }
  if (message.includes(IPC_UNIMPLEMENTED_MARKER)) {
    return { ...base, code: "IPC_UNIMPLEMENTED", retryable: false };
  }
  if (message.includes(IPC_BACKEND_UNAVAILABLE_MARKER)) {
    return { ...base, code: "IPC_BACKEND_UNAVAILABLE", retryable: false };
  }
  if (message.includes("IPC_SECRETS_UNAVAILABLE")) {
    return { ...base, code: "IPC_SECRETS_UNAVAILABLE", retryable: false };
  }
  if (message.includes("IPC_DERIVED_CANCELLED:")) {
    return { ...base, code: "IPC_DERIVED_CANCELLED", retryable: true };
  }
  return undefined;
}

function failureEnvelope(
  error: string,
  errorValue?: unknown,
): Extract<Envelope, { ok: false }> {
  const errorInfo = classifyKnownIpcError(error);
  return {
    ok: false,
    error,
    ...(errorInfo ? { errorInfo } : {}),
    ...(errorValue !== undefined ? { errorValue } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ipc チャネル名（grim: プレフィックスで renderer 側イベント名と衝突させない）
// ─────────────────────────────────────────────────────────────────────────────

export const IPC = {
  /** invoke ルーター（ipcMain.handle、返り値は必ず Envelope）。 */
  invoke: "grim:invoke",
  /** main → renderer のイベント配信（preload がチャネル多重化する）。 */
  event: "grim:event",
  /** renderer 発 emit（ipcMain.on、main が allowlist 検証 → 全窓 broadcast）。 */
  emit: "grim:emit",
  /** windowControls（min/max/close/fullscreen と状態取得）。 */
  windowControl: "grim:window-control",
  /** main → renderer: resize / maximize 状態変化の通知（main 側配線は S6）。 */
  windowResized: "grim:window-resized",
  /** main → renderer: close veto プロトコル（§6.4。main 側配線は S6）。 */
  closeRequested: "grim:close-requested",
  /** renderer → main: close veto の応答（payload: { veto: boolean }）。 */
  closeReply: "grim:close-reply",
  /**
   * renderer → main: onCloseRequested ハンドラ登録数の通知（payload: number）。
   * §6.4 手順 4（ハンドラ未登録の窓 — 起動直後など — は即 close）の判定に使う。
   */
  closeHandlerChanged: "grim:close-handler-changed",
  dialogOpenFolder: "grim:dialog-open-folder",
  dialogOpenFile: "grim:dialog-open-file",
  /** User-picked Web Editor handoffをmain側の固定上限内で読み込む。 */
  dialogOpenWebEditorHandoff: "grim:dialog-open-web-editor-handoff",
  fsReadTextFile: "grim:fs-read-text-file",
  fsReadDir: "grim:fs-read-dir",
  openExternal: "grim:open-external",
  getVersion: "grim:get-version",
  setZoomFactor: "grim:set-zoom-factor",
  /** パネル別窓（§6.5）。main 側実装は S7（S4 は IPC_UNIMPLEMENTED スタブ）。 */
  panelOpen: "grim:panel-open",
  panelFocus: "grim:panel-focus-by-label",
  panelExists: "grim:panel-exists-by-label",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// イベントチャネル allowlist（列挙制、§5.4）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * renderer が全窓へ配信できるイベント。送信元窓を含む自己配信が必要な
 * Codex 窓間同期だけを許可する。
 */
export const RENDERER_EVENT_CHANNEL_ALLOWLIST = [
  "codex:data-changed",
  "codex:lock-event",
  "codex:select-entry",
] as const;

/**
 * native backend と main 内の trusted manager が発行するイベント。renderer
 * の `emit` からは送信できない。
 */
export const BACKEND_EVENT_CHANNEL_ALLOWLIST = [
  // AI ストリーミング（ai.rs / ai_responses.rs / cli_ai.rs の
  // format!("{prefix}:stream-…") 展開形）
  "chat:stream-chunk",
  "chat:stream-done",
  "chat:stream-error",
  "cli:stream-chunk",
  "cli:stream-done",
  "cli:stream-error",
  "inline-ai:stream-chunk",
  "inline-ai:stream-done",
  "inline-ai:stream-error",
  // backend / trusted manager 発: license / post_effect / semantic / vivliostyle
  "license:state_changed",
  "post_effect:progress",
  "post_effect:partial",
  "post_effect:done",
  "post_effect:error",
  "semantic:model_download_progress",
  "semantic:reindex_progress",
  "related-scenes:invalidated",
  "related-scenes:index-ready",
  "vivliostyle:log",
  "vivliostyle:done",
  "vivliostyle:error",
  "vivliostyle:preview-exited",
  // external-mount watcher（useExternalMountListener.ts）
  "external-mount://file-added",
  "external-mount://file-changed",
  "external-mount://file-removed",
  "external-mount://file-renamed",
  // napi の TSFn end-to-end 実証チャネル（§7.1、FE 購読者なし）
  "backend:ready",
  "workspace:opened",
  // Codex App Server main-only normalized event envelope.
  "codex-app:event",
] as const;

/** Electron main 専用のイベント。renderer / backend callback からは送れない。 */
export const MAIN_EVENT_CHANNEL_ALLOWLIST = [
  // electron-updater の byte progress（Phase 4）
  "updater:download-progress",
  // Web Editor handoff deep link: UIを開く合図のみ。path/contentは含めない。
  "web-editor-handoff:requested",
] as const;

/** listen 用の全イベント一覧。送信元別 allowlist の union。 */
export const EVENT_CHANNEL_ALLOWLIST: readonly string[] = [
  ...BACKEND_EVENT_CHANNEL_ALLOWLIST,
  ...MAIN_EVENT_CHANNEL_ALLOWLIST,
  ...RENDERER_EVENT_CHANNEL_ALLOWLIST,
];

const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNEL_ALLOWLIST);
const RENDERER_EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(
  RENDERER_EVENT_CHANNEL_ALLOWLIST,
);
const BACKEND_EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(
  BACKEND_EVENT_CHANNEL_ALLOWLIST,
);
const MAIN_EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(
  MAIN_EVENT_CHANNEL_ALLOWLIST,
);

export function isAllowedEventChannel(channel: string): boolean {
  return EVENT_CHANNEL_SET.has(channel);
}

export function isAllowedRendererEventChannel(channel: string): boolean {
  return RENDERER_EVENT_CHANNEL_SET.has(channel);
}

export function isAllowedBackendEventChannel(channel: string): boolean {
  return BACKEND_EVENT_CHANNEL_SET.has(channel);
}

export function isAllowedMainEventChannel(channel: string): boolean {
  return MAIN_EVENT_CHANNEL_SET.has(channel);
}

// ─────────────────────────────────────────────────────────────────────────────
// 外部 URL スキーム再検証（openExternal — src/lib/safeUrl.ts と二重防御）
// ─────────────────────────────────────────────────────────────────────────────

const SAFE_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

/** http(s)/mailto のみ true。相対 URL・パース不能・危険スキームは false。 */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// zoom（uiScale.ts の setZoom 写像。main 経由に統一 — §3.4）
// ─────────────────────────────────────────────────────────────────────────────

export const ZOOM_FACTOR_MIN = 0.25;
export const ZOOM_FACTOR_MAX = 4;

/** 非数・非有限は 1 に、範囲外はクランプ（renderer 入力を信用しない）。 */
export function clampZoomFactor(factor: unknown): number {
  if (typeof factor !== "number" || !Number.isFinite(factor)) return 1;
  return Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, factor));
}

// ─────────────────────────────────────────────────────────────────────────────
// napi Backend の構造型（electron/native/grimodex-node/index.d.ts と同形。
// 生成物 index.js は gitignore のため import せず構造的に一致させる）
// ─────────────────────────────────────────────────────────────────────────────

export interface EntitySeedCanonicalRangeV1 {
  readonly start: number;
  readonly end: number;
}

export interface EntitySeedCanonicalSourceV1 {
  readonly sourceRef: string;
  readonly documentRef: string;
  readonly documentRange: EntitySeedCanonicalRangeV1;
  readonly text: string;
}

export interface ExtractCodexEntitySeedsRequestV1 {
  readonly schemaVersion: 1;
  readonly normalizerVersion: "gdx-canonical-text/1";
  readonly language: string;
  readonly minimumOccurrenceCount: number;
  readonly sources: readonly EntitySeedCanonicalSourceV1[];
}

export interface NapiBackendLike {
  /** Main-only D2a startup barrier; never registered in renderer IPC. */
  initializeProfileEgress?(): Promise<string>;
  /** Main-only registration of a main-issued caller identity. */
  registerProfileEgressCaller?(identity: string): void;
  /** Main-only invalidation after the trusted workspace binding changes. */
  invalidateProfileEgressCallers?(): void;
  dbExecute(sql: string, params: unknown, method: string): Promise<string>;
  dbExecuteBatch(statements: unknown): Promise<string>;
  narrativeRuntimePolicyGet?(): Promise<string>;
  narrativeRuntimePolicySet?(payload: unknown): Promise<string>;
  editorStickyList?(projectId: string, documentKey: string): Promise<string>;
  editorStickyCreate?(payload: unknown): Promise<string>;
  editorStickyUpdate?(payload: unknown): Promise<string>;
  editorStickyDelete?(payload: unknown): Promise<void>;
  lintIgnoreList?(projectId: string): Promise<string>;
  lintIgnoreListScene?(projectId: string, sceneId: string): Promise<string>;
  lintIgnoreCreate?(payload: unknown): Promise<string>;
  lintIgnoreDelete?(projectId: string, id: string): Promise<void>;
  lintIgnoreCopy?(payload: unknown): Promise<string>;
  lintIgnoreMove?(payload: unknown): Promise<string>;
  lintTermDictionaryList?(projectId: string): Promise<string>;
  lintTermDictionaryInsert?(payload: unknown): Promise<string>;
  lintTermDictionaryUpdate?(payload: unknown): Promise<string>;
  lintTermDictionarySetEnabled?(
    projectId: string,
    id: string,
    enabled: boolean,
    updatedAt: number,
  ): Promise<string>;
  lintTermDictionaryDelete?(projectId: string, id: string): Promise<void>;
  eventGetVersion?(projectId: string, eventId: string): Promise<string>;
  eventSetParticipants?(payload: unknown): Promise<string>;
  projectCalendarUpsert?(payload: unknown): Promise<string>;
  authorshipReplaceLane?(payload: unknown): Promise<void>;
  entityTagsSet?(payload: unknown): Promise<void>;
  codexRenameUndo?(payload: unknown): Promise<string>;
  codexRenameApply?(payload: unknown): Promise<string>;
  scanStagingProjectCreate?(payload: unknown): Promise<void>;
  scanStagingProjectPublish?(payload: unknown): Promise<string>;
  projectCreate?(payload: unknown): Promise<string>;
  projectPatch?(payload: unknown): Promise<string>;
  projectDelete?(payload: unknown): Promise<void>;
  aiTreePlanApply?(payload: unknown): Promise<string>;
  aiTreePlanUndo?(payload: unknown): Promise<string>;
  mapWriteBundle?(payload: unknown): Promise<string>;
  projectSnapshotCreate?(payload: unknown): Promise<void>;
  projectSnapshotRestoreContext?(
    projectId: string,
    snapshotId: string,
    scopes: unknown,
  ): Promise<string>;
  projectSnapshotApplyRestore?(payload: unknown): Promise<string>;
  revisionSceneRestore?(payload: unknown): Promise<string>;
  saveSceneBodyBundle?(payload: unknown): Promise<string>;
  runtimePerformanceSeed?(
    ownerToken: string,
    payload: unknown,
  ): Promise<string>;
  vacuumDatabase(): Promise<void>;
  openWorkspace(path: string): Promise<string>;
  validateWorkspacePath(path: string): boolean;
  /** Main-only one-shot bridge; intentionally absent from NAPI_COMMANDS. */
  readLegacyApiKeysForMigration?(): Promise<string>;
  /** Main/CI-only release feature gate; intentionally absent from IPC. */
  getNativeBuildCapabilities?(): Promise<string>;
  /** Main-only bridge used to build standalone MCP sidecar config. */
  getActiveWorkspacePath?(): Promise<string>;
  /** Main-only Codex App Server thread binding bridge. */
  getChatRuntimeThreadBinding?(
    projectId: string,
    sessionId: string,
    runtime: string,
    expectedWorkspacePath: string,
  ): Promise<string>;
  upsertChatRuntimeThreadBinding?(
    binding: unknown,
    expectedWorkspacePath: string,
  ): Promise<void>;
  /** Main-only pending-to-committed CAS bridge; absent from NAPI_COMMANDS. */
  advanceChatRuntimeThreadHistoryRevision?(
    expectedWorkspacePath: string,
    projectId: string,
    sessionId: string,
    runtime: string,
    externalThreadId: string,
    lastTurnId: string,
    pendingHistoryRevision: string,
    nextHistoryRevision: string,
    updatedAt: string,
  ): Promise<boolean>;
  deleteChatRuntimeThreadBinding?(
    projectId: string,
    sessionId: string,
    runtime: string,
    expectedWorkspacePath: string,
  ): Promise<void>;
  listBackups?(): Promise<string>;
  restoreBackup?(fileName: string): Promise<void>;
  listRecoveryCandidates?(): Promise<string>;
  verifyRecoveryCandidate?(candidateId: string): Promise<string>;
  restoreRecoveryCandidate?(candidateId: string): Promise<void>;
  quarantineLiveDatabase?(): Promise<string>;
  exportSafeModeDiagnostics?(): Promise<string>;
  getGlobalSettings(): Promise<string>;
  saveGlobalSettings(settings: unknown): Promise<void>;
  seedSampleWorkspace?(language: string, aiPolicy: string): Promise<string>;
  importWebEditorWorkspace?(handoffJson: string): Promise<string>;
  timelapseAppendBatch(
    projectId: string,
    sessionId: string,
    events: unknown,
  ): Promise<string>;
  /** Optional so a stale native binding reports an explicit version-skew error. */
  timelapseGenesisBaselinesAppend?(
    expectedWorkspacePath: string,
    projectId: string,
    kind: string,
    entityIds: string[],
    anchorTimestamp: number,
  ): Promise<string>;
  /** Renderer body rebaseline: identities only; Native reads trusted bodies. */
  timelapseBodyBaselinesAppend?(
    expectedWorkspacePath: string,
    projectId: string,
    targets: unknown,
    expectedAnchorSequence: number | null,
  ): Promise<string>;
  /**
   * Logically reset one project: canonical change_events/hash chain remain,
   * project state_snapshots are deleted, and Native advances the trusted
   * resetSequence cutoff. The result contains the logical hidden-event count
   * and deleted-snapshot count.
   */
  timelapseHistoryPurge?(
    expectedWorkspacePath: string,
    projectId: string,
  ): Promise<string>;
  /** Set timelapse.enabled under the exact workspace binding. */
  timelapseEnabledSet?(
    expectedWorkspacePath: string,
    projectId: string,
    enabled: boolean,
  ): Promise<string>;
  /** Fixed layout/workspace/workspace snapshot scope. */
  timelapseLayoutSnapshotRecord?(
    expectedWorkspacePath: string,
    projectId: string,
    payload: unknown,
    expectedAnchorSequence: number | null,
  ): Promise<string>;
  aiAuditAppendBatch(
    expectedWorkspacePath: string,
    projectId: string | null,
    events: unknown,
  ): Promise<string>;
  /** Main-owned, single-transaction claim for a CLI dispatch. */
  aiAuditClaimCliDispatch(
    expectedWorkspacePath: string,
    projectId: string | null,
    executionId: string,
    operationId: string,
    parentExecutionId: string | null,
    pathId: string,
    expectedRequestSha256: string,
  ): Promise<string>;
  aiAuditReadSnapshot(
    expectedWorkspacePath: string,
    projectId: string | null,
    afterSequence: number | undefined,
    highWaterSequence: number | undefined,
    limit: number | undefined,
  ): Promise<string>;
  aiAuditVerify(
    expectedWorkspacePath: string,
    projectId: string | null,
    highWaterSequence: number | undefined,
  ): Promise<string>;
  imeExportRefresh(
    projectId: string,
    expectedWorkspacePath: string,
    options: unknown,
  ): Promise<string>;
  imeExportSetActiveProject(
    projectId: string | null | undefined,
    expectedWorkspacePath: string | null | undefined,
    mode: string,
  ): Promise<string>;
  /** Electron main の終了処理専用。renderer IPC には公開しない。 */
  imeExportDeactivateOnExit(): void;
  imeExportGetStatus(mode: string): Promise<string>;
  imeExportClearAll(): Promise<void>;
  imeExportRemoveProject(
    projectId: string,
    expectedWorkspacePath: string,
  ): Promise<void>;
  trashBinCreate(payload: unknown): Promise<string>;
  trashBinRestore(payload: unknown): Promise<string>;
  trashBinList(projectId: string, limit?: number | null): Promise<string>;
  trashBinDelete(id: string): Promise<void>;
  trashBinClearAll(projectId: string): Promise<void>;
  trashBinPrune(
    projectId: string,
    retentionDays: number,
    maxCount: number,
  ): Promise<string>;
  ftsOptimize(): Promise<void>;
  ftsRebuild(): Promise<void>;
  ftsRebuildEn(): Promise<void>;
  ftsSearch(
    projectId: string,
    query: string,
    scope: string,
    limit: number,
  ): Promise<string>;
  integrityCheck(projectId: string): Promise<string>;
  repairIntegrity(payload: unknown): Promise<string>;
  lintText(
    blocks: unknown,
    language: string,
    scope: unknown,
    config: unknown,
    disables?: unknown,
  ): Promise<string>;
  segmentBunsetsu(text: string): Promise<string>;
  listSystemFonts(): Promise<string>;
  codexRebuildMatcher(entries: unknown): Promise<void>;
  codexMatchText(text: string, excludeEntryIds: string[]): Promise<string>;
  extractCodexCandidates(
    projectId: string,
    minCount?: number | null,
  ): Promise<string>;
  /** Optional so an older native binding fails with an explicit version-skew marker. */
  extractCodexEntitySeeds?(
    request: ExtractCodexEntitySeedsRequestV1,
  ): Promise<string>;
  // Semantic Phase 3 Batch 4。optional は旧 .node とのversion skewを
  // requireNapiMethodで明示エラーにするため。usize相当はIPCでu32へ狭める。
  semanticDownloadModel?(language: string): Promise<string>;
  semanticCancelBackground?(): Promise<string>;
  semanticIndexScene?(
    expectedWorkspacePath: string,
    projectId: string,
    sceneId: string,
  ): Promise<string>;
  semanticSearch?(
    expectedWorkspacePath: string,
    projectId: string,
    query: string,
    limit: number,
    sceneScope?: string | null,
    descriptionMode?: boolean | null,
  ): Promise<string>;
  relatedScenesBegin?(request: unknown): Promise<string>;
  relatedScenesContinue?(ownerKey: string, operationTicket: string): Promise<string>;
  relatedScenesRelease?(ownerKey: string, operationTicket: string): Promise<string>;
  nir1EvidenceQualify?(ownerKey: string, navigationIdentity: string): Promise<string>;
  /** Native-only NIR-1 graph scaffold; deliberately absent from renderer IPC. */
  nir1GraphQuery?(payload: unknown): Promise<string>;
  /** Native-only atomic Raw/IR/Graph context packing. */
  nir1PackContext?(payload: unknown): Promise<string>;
  /** Native-bound typed Entity/Relation Revision proposal writer. */
  nir1EntityRelationRevisionCreate?(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  /** Cold reader for an explicitly human-approved typed Revision. */
  nir1EntityRelationRevisionRead?(payload: unknown): Promise<string>;
  narrativeSceneScopeRead?(payload: unknown): Promise<string>;
  narrativeSceneScopeUpdate?(payload: unknown): Promise<string>;
  narrativeSceneScopeRegistryUpdate?(payload: unknown): Promise<string>;
  /** Main lifecycle only; deliberately absent from the renderer command map. */
  relatedScenesReleaseOwner?(ownerKey: string): Promise<string>;
  /** Main observer only; never a renderer command. */
  relatedScenesReconcile?(): Promise<string>;
  semanticRerankerShadowScore?(request: unknown): Promise<string>;
  codexIndexEntry?(
    expectedWorkspacePath: string,
    projectId: string,
    entryId: string,
  ): Promise<string>;
  codexSemanticSearch?(
    expectedWorkspacePath: string,
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  codexIndexStatus?(projectId: string): Promise<string>;
  codexReindexAll?(
    expectedWorkspacePath: string,
    projectId: string,
  ): Promise<string>;
  eventsIndexEntry?(
    expectedWorkspacePath: string,
    projectId: string,
    eventId: string,
  ): Promise<string>;
  eventsSemanticSearch?(
    expectedWorkspacePath: string,
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  eventsIndexStatus?(projectId: string): Promise<string>;
  eventsReindexAll?(
    expectedWorkspacePath: string,
    projectId: string,
  ): Promise<string>;
  chatIndexMessage?(
    expectedWorkspacePath: string,
    projectId: string,
    messageId: string,
  ): Promise<string>;
  chatMessageSearch?(
    expectedWorkspacePath: string,
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  chatIndexStatus?(projectId: string): Promise<string>;
  chatReindexAll?(
    expectedWorkspacePath: string,
    projectId: string,
  ): Promise<string>;
  semanticIndexStatus?(projectId: string): Promise<string>;
  semanticReindexAll?(
    expectedWorkspacePath: string,
    projectId: string,
    runId?: string | null,
  ): Promise<string>;
  semanticChunkContext?(
    sceneId: string,
    charStart: number,
    charEnd: number,
    padding: number,
  ): Promise<string>;
  semanticDebugDump?(
    projectId: string,
    sceneId?: string | null,
    limit?: number | null,
  ): Promise<string>;
  plotThreadCreate(payload: unknown): Promise<string>;
  plotThreadUpdate(id: string, patch: unknown): Promise<string>;
  plotThreadDelete(payload: unknown): Promise<string>;
  plotThreadList(projectId: string): Promise<string>;
  plotThreadLinkCreate(payload: unknown): Promise<string>;
  plotThreadBranchCreate?(payload: unknown): Promise<string>;
  plotThreadBranchUpdate?(id: string, patch: unknown): Promise<string>;
  plotThreadBranchDelete?(payload: unknown): Promise<string>;
  plotThreadMoveMarkerBundle?(payload: unknown): Promise<string>;
  plotThreadRestoreSnapshot?(payload: unknown): Promise<string>;
  plotThreadDeleteSnapshot?(payload: unknown): Promise<string>;
  plotThreadLinkUpdate(id: string, patch: unknown): Promise<string>;
  plotThreadLinkDelete(payload: unknown): Promise<string>;
  plotThreadListLinks(projectId: string): Promise<string>;
  foreshadowCreate(payload: unknown): Promise<string>;
  foreshadowUpdate(id: string, patch: unknown): Promise<string>;
  foreshadowDelete(payload: unknown): Promise<string>;
  foreshadowListWithLabels(projectId: string): Promise<string>;
  foreshadowListOpenForContext(projectId: string): Promise<string>;
  foreshadowGetSceneInfo(sceneId: string): Promise<string>;
  foreshadowGetSceneContext(sceneId: string): Promise<string>;
  foreshadowListByCodexEntry(codexEntryId: string): Promise<string>;
  foreshadowGetChapterStats(chapterId: string): Promise<string>;
  foreshadowGetSetup(setupId: string): Promise<string>;
  foreshadowUpdateSetup(id: string, patch: unknown): Promise<string>;
  foreshadowGet(id: string): Promise<string>;
  foreshadowLinkCodex(payload: unknown): Promise<string>;
  foreshadowUnlinkCodex(payload: unknown): Promise<string>;
  foreshadowListLinkedCodex(foreshadowId: string): Promise<string>;
  foreshadowSetSetupStrength(payload: unknown): Promise<string>;
  foreshadowSetupCreateAi(input: unknown): Promise<string>;
  foreshadowResolveOrphan(payload: unknown): Promise<string>;
  foreshadowSaveAnchorsForScene(payload: unknown): Promise<string>;
  foreshadowLoadAnchorsForScene(sceneId: string): Promise<string>;
  // agent_writes commands（すべて単一 payload → tracked write result）
  agentCodexCreate(payload: unknown): Promise<string>;
  agentCodexUpdate(payload: unknown): Promise<string>;
  agentCodexDelete(payload: unknown): Promise<string>;
  // Human/import/history renderer Codex writers. Optional は旧 .node との
  // version skew を requireNapiMethod で明示エラー化するため。
  codexCreate?(payload: unknown): Promise<string>;
  codexUpdate?(payload: unknown): Promise<string>;
  codexDelete?(payload: unknown): Promise<string>;
  codexMutate?(payload: unknown): Promise<string>;
  agentCodexMutate(payload: unknown): Promise<string>;
  agentWriteBundle(payload: unknown): Promise<string>;
  agentSnippetCreate(payload: unknown): Promise<string>;
  snippetCreate(payload: unknown): Promise<string>;
  snippetUpdate(payload: unknown): Promise<string>;
  snippetDelete(payload: unknown): Promise<string>;
  agentProposeSceneBody(payload: unknown): Promise<string>;
  agentAcceptProseStage(payload: unknown): Promise<string>;
  agentDiscardProseStage(payload: unknown): Promise<string>;
  agentApplyUndoJournal(payload: unknown): Promise<string>;
  agentForeshadowCreate(payload: unknown): Promise<string>;
  agentForeshadowUpdate(payload: unknown): Promise<string>;
  agentEventCreate(payload: unknown): Promise<string>;
  agentEventUpdate(payload: unknown): Promise<string>;
  agentEventDelete(payload: unknown): Promise<string>;
  agentChronicleBulkMutate?(payload: unknown): Promise<string>;
  agentEventSetParticipants(payload: unknown): Promise<string>;
  agentSceneEventLink(payload: unknown): Promise<string>;
  agentSceneEventLinkBatch?(payload: unknown): Promise<string>;
  agentSceneEventUnlink(payload: unknown): Promise<string>;
  agentEventRelationAdd(payload: unknown): Promise<string>;
  agentEventRelationRemove(payload: unknown): Promise<string>;
  eventCreate?(payload: unknown): Promise<string>;
  eventUpdate?(payload: unknown): Promise<string>;
  eventDelete?(payload: unknown): Promise<string>;
  chronicleBulkMutate?(payload: unknown): Promise<string>;
  eventParticipantsSet?(payload: unknown): Promise<string>;
  sceneEventLink?(payload: unknown): Promise<string>;
  sceneEventLinkBatch?(payload: unknown): Promise<string>;
  sceneEventUnlink?(payload: unknown): Promise<string>;
  eventRelationAdd?(payload: unknown): Promise<string>;
  eventRelationRemove?(payload: unknown): Promise<string>;
  treeNodeCreate(payload: unknown): Promise<string>;
  treeNodeDelete(payload: unknown): Promise<string>;
  treeNodePatch(payload: unknown): Promise<string>;
  temporalScenePatch(payload: unknown): Promise<string>;
  narrativeExtractionCaptureWorkspaceBinding?(
    expectedWorkspacePath: string,
  ): Promise<string>;
  narrativeExtractionCreateRun(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionGetRun(payload: unknown): Promise<string>;
  narrativeExtractionListResumableRuns(payload: unknown): Promise<string>;
  narrativeExtractionIsRunResumableForReview?(
    payload: unknown,
  ): Promise<string>;
  narrativeExtractionListChronicleTaskResumeCandidates?(
    payload: unknown,
  ): Promise<string>;
  narrativeExtractionCancelRun(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionClaimTask(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionFinishTask(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionFailTask(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionSaveProposalSet(
    payload: unknown,
    workspaceBinding: unknown,
  ): Promise<string>;
  narrativeExtractionCreateHumanDerivedRevision(
    payload: unknown,
  ): Promise<string>;
  narrativeExtractionGetRunReviewBundle(payload: unknown): Promise<string>;
  narrativeExtractionAppendRevision(payload: unknown): Promise<string>;
  narrativeExtractionAppendDecision(payload: unknown): Promise<string>;
  narrativeExtractionAppendHumanDecision(payload: unknown): Promise<string>;
  narrativeExtractionReviseAndDecide(payload: unknown): Promise<string>;
  narrativeExtractionReviseAndDecideAsHuman(payload: unknown): Promise<string>;
  narrativeExtractionSetHumanFieldLock(payload: unknown): Promise<string>;
  narrativeExtractionPrepareCommit(payload: unknown): Promise<string>;
  narrativeExtractionApplyCommit(payload: unknown): Promise<string>;
  narrativeExtractionGetCommitStatus(payload: unknown): Promise<string>;
  narrativeExtractionUndoCommit(payload: unknown): Promise<string>;
  narrativeExtractionRedoCommit(payload: unknown): Promise<string>;
  // Gate C2-T1: Attention typed writer / Maintenance Inbox read model
  narrativeMaintenanceAttentionSet?(payload: unknown): Promise<string>;
  narrativeMaintenanceAttentionClear?(payload: unknown): Promise<string>;
  narrativeMaintenanceInboxList?(payload: unknown): Promise<string>;
  // Gate C2 Run Kind Policy: the five named operations replacing the old
  // two-value rebuildNarrativeDependencyIndex(mode: verify|repair)
  verifyNarrativeDependencyGraph?(payload: unknown): Promise<string>;
  rebuildNarrativeDerivedState?(payload: unknown): Promise<string>;
  getNarrativeBackfillStatus?(payload: unknown): Promise<string>;
  retryNarrativeLegacyBackfill?(payload: unknown): Promise<string>;
  repairNarrativeDependencyDeclarations?(payload: unknown): Promise<string>;
  // post_effect pure-db 7 コマンド
  listPostEffectRuns(
    projectId: string,
    effectType?: string | null,
    limit?: number | null,
    offset?: number | null,
  ): Promise<string>;
  listSceneLensForProject(projectId: string): Promise<string>;
  listAnnotationsForScene(
    projectId: string,
    sceneId: string,
    status?: string | null,
  ): Promise<string>;
  listAnnotationsForProject(
    projectId: string,
    status?: string | null,
  ): Promise<string>;
  updateAnnotationStatus(
    annotationId: string,
    status: string,
    projectId: string,
  ): Promise<string>;
  replyToAnnotation(args: unknown): Promise<string>;
  savePostEffectAnnotations(
    projectId: string,
    sceneId: string,
    annotations: unknown,
  ): Promise<void>;
  // license（Phase 3e）。optional は旧 .node とのversion skewを明示エラーに
  // するため。runLicenseValidateCycleはrenderer commandではなくmain scheduler専用。
  getLicenseState?(): Promise<string>;
  activateLicense?(key: string): Promise<string>;
  revalidateLicense?(): Promise<string>;
  deactivateLicense?(): Promise<string>;
  runLicenseValidateCycle?(): Promise<string | null>;
  // renderer command ではなく、Change Feed を駆動する Electron main
  // scheduler 専用。1回につきNative側の有界batchを最大1件処理する。
  runNarrativeFreshnessCycle?(): Promise<string | null>;
  // main-only enqueue snapshot for the serialized system-work seam. This is
  // synchronous so a request can be bound before it enters the pending queue.
  getNarrativeMaintenanceWorkspaceBinding?(): string | null;
  // renderer/preload には公開しない serialized system-work seam。入力は
  // Electron main scheduler が coalesce 済みの project-scoped work DTO。
  runNarrativeMaintenanceCycle?(payload: unknown): Promise<string>;
  // post_effect run 系（Phase 3d）。settings は dispatch が1回だけ読んだ
  // AiSettings snapshot。API key は未登録時 null、safeStorage lookup 自体が
  // 失敗した場合は apiKeyError に生メッセージを載せる。native は cache hit なら
  // secret snapshot を使わず返せるため、lookup失敗をここでinvoke rejectにしない。
  // optional は旧 .node とのversion skewをrequireNapiMethodで明示エラー化するため。
  startPostEffectRun?(
    args: unknown,
    settings: unknown,
    apiKey: string | null,
    apiKeyError: string | null,
  ): Promise<string>;
  startPostEffectRunMulti?(
    args: unknown,
    settings: unknown,
    apiKey: string | null,
    apiKeyError: string | null,
  ): Promise<string>;
  abortPostEffectRun?(runId: string, projectId: string): Promise<void>;
  // AI チャット（Phase 3 バッチ3a）。args は FE の camelCase 引数一式、settings は
  // dispatchInvoke が getAiSettings で1回だけ読んだ AiSettings スナップショット
  // （キー解決と送信を同一スナップショットで行い Tauri の原子的単一読込に揃える）、
  // apiKey は main の safeStorage で解決した平文（napi は keyring を触らない）。
  getAiSettings(): Promise<string>;
  sendChatMessage(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<string>;
  sendChatMessageStream(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<void>;
  abortChatStream(streamId: string): Promise<boolean>;
  // AI Phase 3b（settings snapshot + safeStorage key注入は3a chatと同じ）。
  // optional は旧 .node とのバージョンスキューを型境界で表すため。コマンド実行時は
  // requireNapiMethod が必ず存在確認し、欠落を明示エラーにする。
  saveAiSettings?(settings: unknown): Promise<void>;
  sendInlineAiStream?(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<void>;
  abortInlineAiStream?(streamId: string): Promise<boolean>;
  sendAgentMessage?(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<string>;
  listAiModels?(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<string>;
  testAiConnection?(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<string>;
  onEvent(callback: (...args: unknown[]) => unknown): void;
}

/**
 * API キー解決の窓口（実体は electron/main/keyStore.ts の SecretsBridge）。
 * napi のチャットコマンドは平文キーを引数注入で受けるため、dispatchInvoke が
 * 送信直前に safeStorage 経由でキーを解決する。renderer には平文を出さない
 * （解決は main プロセス内で完結）。keyStore の SecretsBridge が構造的に満たす。
 */
export interface SecretsResolver {
  /** 設定 + FE 引数(provider/endpoint override) から実効 API キーを解決。空文字許容。 */
  resolveApiKeyForRequest(
    settings: unknown,
    argProvider: unknown,
    argEndpointId: unknown,
  ): string;
  /** list_ai_models用。未登録はnull、ストア/復号エラーはthrow。 */
  getApiKeyForRequest?(
    settings: unknown,
    argProvider: unknown,
    argEndpointId: unknown,
  ): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// コマンド表 + 引数アダプタ
// ─────────────────────────────────────────────────────────────────────────────

export type CommandArgs = Record<string, unknown>;

/**
 * Tauri の「invalid args」系エラーの近似（誰も文字列一致していないが、
 * デバッグ時に Tauri 側と同じ語彙で読めるようにする）。
 */
function requireString(args: CommandArgs, key: string, cmd: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string`,
    );
  }
  return value;
}

/** restore_backup は renderer 入力をそのままfilesystem pathへ渡さない。 */
function requireBackupFileName(args: CommandArgs): string {
  const command = "restore_backup";
  const key = "fileName";
  const value = requireString(args, key, command);
  const supportedSuffix = value.endsWith(".db.gz")
    ? ".db.gz"
    : value.endsWith(".db")
      ? ".db"
      : null;
  const stemLength = supportedSuffix
    ? value.length - "grimodex-".length - supportedSuffix.length
    : 0;
  if (
    !value.startsWith("grimodex-") ||
    stemLength < 1 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..")
  ) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a safe grimodex-*.db or grimodex-*.db.gz basename`,
    );
  }
  return value;
}

function requireRecoveryCandidateId(
  args: CommandArgs,
  command: string,
): string {
  const key = "candidateId";
  const value = requireString(args, key, command);
  if (!/^rc_[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected an opaque rc_ recovery candidate id`,
    );
  }
  return value;
}

function requirePresent(args: CommandArgs, key: string, cmd: string): unknown {
  if (!Object.hasOwn(args, key) || args[key] === undefined) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: missing required key ${key}`,
    );
  }
  return args[key];
}

/** Tauri の nested struct 引数の近似（null / 配列 / primitive は拒否）。 */
function requireRecord(
  args: CommandArgs,
  key: string,
  cmd: string,
): CommandArgs {
  const value = requirePresent(args, key, cmd);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected an object`,
    );
  }
  return value as CommandArgs;
}

function requireChronicleTaskResumeCandidatesPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "narrative_extraction_list_chronicle_task_resume_candidates";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId", "limit"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  const projectId = requireNonEmptyString(payload, "projectId", command);
  if (projectId.trim().length === 0 || projectId.trim() !== projectId) {
    throw new Error(
      `invalid args \`projectId\` for command \`${command}\`: expected a non-empty exact string`,
    );
  }
  if (!Object.hasOwn(payload, "limit") || payload.limit === undefined) {
    return { projectId };
  }
  const limit = requireSafeInteger(payload, "limit", command);
  if (limit < 1 || limit > 100) {
    throw new Error(
      `invalid args \`limit\` for command \`${command}\`: expected an integer from 1 through 100`,
    );
  }
  return { projectId, limit };
}

function requireReviewResumabilityPayload(args: CommandArgs): CommandArgs {
  const command = "narrative_extraction_is_run_resumable_for_review";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["runId", "projectId", "surfacePathId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  const exactString = (key: "runId" | "projectId" | "surfacePathId") => {
    const value = requireNonEmptyString(payload, key, command);
    if (value.trim().length === 0 || value.trim() !== value) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a non-empty exact string`,
      );
    }
    return value;
  };
  return {
    runId: exactString("runId"),
    projectId: exactString("projectId"),
    surfacePathId: exactString("surfacePathId"),
  };
}

function requireNarrativeExtractionWorkspaceBinding(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const binding = requireRecord(args, "workspaceBinding", command);
  const keys = Object.keys(binding);
  if (
    keys.length !== 3 ||
    !Object.hasOwn(binding, "authorityId") ||
    !Object.hasOwn(binding, "generation") ||
    !Object.hasOwn(binding, "authorityInstanceId")
  ) {
    throw new Error(
      `invalid args \`workspaceBinding\` for command \`${command}\`: expected exact authorityId/generation/authorityInstanceId binding`,
    );
  }
  const authorityId = requireNonEmptyString(binding, "authorityId", command);
  if (authorityId.trim() !== authorityId) {
    throw new Error(
      `invalid args \`authorityId\` for command \`${command}\`: expected a non-empty exact string`,
    );
  }
  const generation = requireSafeInteger(binding, "generation", command);
  if (generation < 1) {
    throw new Error(
      `invalid args \`generation\` for command \`${command}\`: expected a positive safe integer`,
    );
  }
  const authorityInstanceId = requireNonEmptyString(
    binding,
    "authorityInstanceId",
    command,
  );
  if (!/^[1-9][0-9]*$/u.test(authorityInstanceId)) {
    throw new Error(
      `invalid args \`authorityInstanceId\` for command \`${command}\`: expected a canonical positive decimal integer`,
    );
  }
  return { authorityId, generation, authorityInstanceId };
}

function requireNarrativeExtractionBoundMutation(
  args: CommandArgs,
  command: string,
): readonly [unknown, CommandArgs] {
  if (
    Object.keys(args).some(
      (key) => key !== "payload" && key !== "workspaceBinding",
    )
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: unknown top-level field`,
    );
  }
  return [
    requirePresent(args, "payload", command),
    requireNarrativeExtractionWorkspaceBinding(args, command),
  ];
}

function requireNarrativeExtractionCaptureWorkspacePath(
  args: CommandArgs,
): string {
  const command = "narrative_extraction_capture_workspace_binding";
  if (
    Object.keys(args).length !== 1 ||
    !Object.hasOwn(args, "expectedWorkspacePath")
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected only expectedWorkspacePath`,
    );
  }
  const path = requireNonEmptyString(args, "expectedWorkspacePath", command);
  if (path.trim() !== path) {
    throw new Error(
      `invalid args \`expectedWorkspacePath\` for command \`${command}\`: expected a non-empty exact string`,
    );
  }
  return path;
}

function requireTrashBinRestorePayload(args: CommandArgs): CommandArgs {
  const command = "trash_bin_restore";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set([
    "requestId",
    "sessionId",
    "projectId",
    "itemId",
    "boardIdOverride",
    "dropX",
    "dropY",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  for (const key of ["requestId", "sessionId", "projectId", "itemId"]) {
    requireNonEmptyString(payload, key, command);
  }
  optionalString(payload, "boardIdOverride", command);
  optionalNumber(payload, "dropX", command);
  optionalNumber(payload, "dropY", command);
  return payload;
}

const NARRATIVE_RUNTIME_MODES = new Set([
  "disabled",
  "review-only",
  "manual-apply",
  "automatic",
]);

function requireNarrativeRuntimePolicySetPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "narrative_runtime_policy_set";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set([
    "expectedVersion",
    "runtimeMode",
    "maintenanceEnabled",
    "genericImportEnabled",
    "backgroundAiEnabled",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(payload, key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: missing required key ${key}`,
      );
    }
  }
  const expectedVersion = requireSafeInteger(
    payload,
    "expectedVersion",
    command,
  );
  if (expectedVersion < 0) {
    throw new Error(
      `invalid args \`expectedVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  const runtimeMode = requireString(payload, "runtimeMode", command);
  if (!NARRATIVE_RUNTIME_MODES.has(runtimeMode)) {
    throw new Error(
      `invalid args \`runtimeMode\` for command \`${command}\`: expected disabled|review-only|manual-apply|automatic`,
    );
  }
  requireBoolean(payload, "maintenanceEnabled", command);
  requireBoolean(payload, "genericImportEnabled", command);
  requireBoolean(payload, "backgroundAiEnabled", command);
  return {
    expectedVersion,
    runtimeMode,
    maintenanceEnabled: payload.maintenanceEnabled,
    genericImportEnabled: payload.genericImportEnabled,
    backgroundAiEnabled: payload.backgroundAiEnabled,
  };
}

const NARRATIVE_MAINTENANCE_ATTENTION_DISPOSITIONS = new Set([
  "snoozed",
  "dismissed",
  "flagged",
]);

function requireNarrativeMaintenanceAttentionSetPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "narrative_maintenance_attention_set";
  const payload = requireRecord(args, "payload", command);
  // setBy は actorId + requestId + expectedVersion（OCC）へ置換済み。
  // 旧 wire を送ってきた renderer は unknown field で明示的に落とす。
  const allowedKeys = new Set([
    "projectId",
    "findingKey",
    "disposition",
    "materialBasisDigest",
    "snoozedUntil",
    "actorId",
    "requestId",
    "reason",
    "expectedVersion",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "findingKey", command);
  const disposition = requireString(payload, "disposition", command);
  if (!NARRATIVE_MAINTENANCE_ATTENTION_DISPOSITIONS.has(disposition)) {
    throw new Error(
      `invalid args \`disposition\` for command \`${command}\`: expected snoozed|dismissed|flagged`,
    );
  }
  requireNonEmptyString(payload, "materialBasisDigest", command);
  optionalString(payload, "snoozedUntil", command);
  requireNonEmptyString(payload, "actorId", command);
  requireNonEmptyString(payload, "requestId", command);
  optionalString(payload, "reason", command);
  // OCC トークン: 0 = 行が未作成であることを期待、N = version N の行を期待。
  requireNonNegativeSafeInteger(payload, "expectedVersion", command);
  return payload;
}

function requireNarrativeMaintenanceAttentionClearPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "narrative_maintenance_attention_clear";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set([
    "projectId",
    "findingKey",
    "actorId",
    "requestId",
    "expectedVersion",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "findingKey", command);
  requireNonEmptyString(payload, "actorId", command);
  requireNonEmptyString(payload, "requestId", command);
  requireNonNegativeSafeInteger(payload, "expectedVersion", command);
  return payload;
}

function requireNarrativeMaintenanceInboxListPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "narrative_maintenance_inbox_list";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

// Gate C2 Run Kind Policy: the five named operations replacing the old
// two-value rebuildNarrativeDependencyIndex(mode: verify|repair).

function requireVerifyNarrativeDependencyGraphPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "verify_narrative_dependency_graph";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

function requireRebuildNarrativeDerivedStatePayload(
  args: CommandArgs,
): CommandArgs {
  const command = "rebuild_narrative_derived_state";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

function requireGetNarrativeBackfillStatusPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "get_narrative_backfill_status";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

function requireRetryNarrativeLegacyBackfillPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "retry_narrative_legacy_backfill";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set(["projectId"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

/**
 * `apply: false`（省略時デフォルト）は sealed repair plan のプレビューのみ。
 * `apply: true` で実行する場合は `planDigest`（直前の preview 呼び出しが
 * 返した digest と一致必須 — Durable Graph が変化していれば native 側で
 * NEX_REPAIR_PLAN_DIGEST_MISMATCH として拒否される）と `leaseOwner`
 * （排他 Repair lease の claim 者識別子）が必須になる。native 側の
 * 前提条件チェック（NEX_REPAIR_*）と重複するが、明らかに欠けている必須
 * フィールドはここで早期に拒否する。
 *
 * `requestId` / `actorId` は preview・apply どちらでも必須。
 * run kind policy（policies/narrative/narrative-run-kind-policy.json の
 * dependency-repair）が `requiredPreconditions: stable-request-id` と
 * `sameRequestIdReuse: idempotent-replay` を宣言しているため、
 * 同じ `requestId` + 同じ plan digest の再送は新規 Repair ではなく
 * idempotent replay として扱われる（stable な値を renderer が採番する）。
 * `actorId` はこの破壊的操作を誰が承認したかの記録で、省略を許すと
 * explicit-confirmation の監査証跡が欠落する。
 */
function requireRepairNarrativeDependencyDeclarationsPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "repair_narrative_dependency_declarations";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set([
    "projectId",
    "verifyRunId",
    "requestId",
    "actorId",
    "apply",
    "planDigest",
    "leaseOwner",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "verifyRunId", command);
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "actorId", command);
  const apply = optionalBoolean(payload, "apply", command) ?? false;
  optionalString(payload, "planDigest", command);
  optionalString(payload, "leaseOwner", command);
  if (apply) {
    requireNonEmptyString(payload, "planDigest", command);
    requireNonEmptyString(payload, "leaseOwner", command);
  }
  return payload;
}

function requirePlotThreadBranchCreatePayload(args: CommandArgs): CommandArgs {
  const command = "plot_thread_branch_create";
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  const requiredStringKeys = [
    "projectId",
    "fromThreadId",
    "toThreadId",
    "atNodeId",
  ] as const;
  for (const key of requiredStringKeys) {
    if (requireString(payload, key, command).length === 0) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  }
  if (Object.hasOwn(payload, "id")) {
    if (requireString(payload, "id", command).length === 0) {
      throw new Error(
        `invalid args \`id\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  }
  const kind = requireString(payload, "kind", command);
  if (kind !== "branch" && kind !== "merge") {
    throw new Error(
      `invalid args \`kind\` for command \`${command}\`: expected branch or merge`,
    );
  }
  return payload;
}

const PLOT_MUTATION_ORIGINS = new Set([
  "human",
  "ai-apply",
  "import",
  "undo",
  "redo",
  "restore",
]);

function requirePlotMutationIdentity(
  payload: CommandArgs,
  command: string,
): void {
  for (const key of [
    "projectId",
    "requestId",
    "sessionId",
    "eventUid",
  ] as const) {
    requireNonEmptyString(payload, key, command);
  }
  const origin = requireString(payload, "origin", command);
  if (!PLOT_MUTATION_ORIGINS.has(origin)) {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: expected a supported Change Feed origin`,
    );
  }
  const originalTransactionId = optionalString(
    payload,
    "originalTransactionId",
    command,
  );
  const undoJournalId = optionalString(payload, "undoJournalId", command);
  if ((origin === "undo" || origin === "redo") && !originalTransactionId) {
    throw new Error(
      `invalid args \`originalTransactionId\` for command \`${command}\`: undo/redo requires lineage`,
    );
  }
  if ((origin === "undo" || origin === "redo") && !undoJournalId) {
    throw new Error(
      `invalid args \`undoJournalId\` for command \`${command}\`: undo/redo requires journal lineage`,
    );
  }
  if (origin !== "undo" && origin !== "redo" && originalTransactionId) {
    throw new Error(
      `invalid args \`originalTransactionId\` for command \`${command}\`: forward mutation cannot name lineage`,
    );
  }
  if (origin !== "undo" && origin !== "redo" && undoJournalId) {
    throw new Error(
      `invalid args \`undoJournalId\` for command \`${command}\`: forward mutation cannot name lineage`,
    );
  }
}

function requirePlotCreatePayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  return payload;
}

function requirePlotVersionedPatch(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const patch = requireRecord(args, "patch", command);
  requirePlotMutationIdentity(patch, command);
  const baseVersion = requireSafeInteger(patch, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return patch;
}

function requirePlotDeletePayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  requireNonEmptyString(payload, "id", command);
  const baseVersion = requireSafeInteger(payload, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return payload;
}

function requireForeshadowVersionedPatch(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const patch = requireRecord(args, "patch", command);
  requireForeshadowMutationIdentity(patch, command);
  if (
    command === "foreshadow_update" ||
    command === "foreshadow_update_setup"
  ) {
    requireForeshadowRendererAuthority(patch, command, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }
  const baseVersion = requireSafeInteger(patch, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return patch;
}

function requireForeshadowMutationIdentity(
  payload: CommandArgs,
  command: string,
): void {
  for (const key of [
    "projectId",
    "requestId",
    "sessionId",
    "eventUid",
  ] as const) {
    requireNonEmptyString(payload, key, command);
  }
  const origin = requireString(payload, "origin", command);
  if (!PLOT_MUTATION_ORIGINS.has(origin)) {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: expected a supported Change Feed origin`,
    );
  }
  const originalTransactionId = optionalString(
    payload,
    "originalTransactionId",
    command,
  );
  if ((origin === "undo" || origin === "redo") && !originalTransactionId) {
    throw new Error(
      `invalid args \`originalTransactionId\` for command \`${command}\`: undo/redo requires lineage`,
    );
  }
  if (origin !== "undo" && origin !== "redo" && originalTransactionId) {
    throw new Error(
      `invalid args \`originalTransactionId\` for command \`${command}\`: forward mutation cannot name lineage`,
    );
  }
  if (Object.hasOwn(payload, "authorityRoute")) {
    requireCanonicalAuthorityContext(payload, command);
  }
}

function requireForeshadowRendererAuthority(
  payload: CommandArgs,
  command: string,
  allowedRoutes: readonly string[],
): void {
  if (!Object.hasOwn(payload, "authorityRoute")) {
    throw new Error(
      `invalid authority route for command \`${command}\`: every Foreshadow mutation requires canonical authority context`,
    );
  }
  requireCanonicalAuthorityContext(payload, command);
  if (!allowedRoutes.includes(String(payload.authorityRoute))) {
    throw new Error(
      `invalid authority route for command \`${command}\`: ${String(payload.authorityRoute)} is not allowed`,
    );
  }
}

function requireForeshadowPayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  requireForeshadowMutationIdentity(payload, command);
  if (
    command === "foreshadow_create" ||
    command === "foreshadow_save_anchors_for_scene" ||
    command === "foreshadow_link_codex" ||
    command === "foreshadow_unlink_codex" ||
    command === "foreshadow_set_setup_strength"
  ) {
    requireForeshadowRendererAuthority(
      payload,
      command,
      command === "foreshadow_create"
        ? ["human-direct", "history-replay", "restore-or-migration"]
        : ["human-direct"],
    );
  }
  return payload;
}

function requireForeshadowDeletePayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireForeshadowPayload(args, command);
  if (command === "foreshadow_delete") {
    requireForeshadowRendererAuthority(payload, command, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }
  requireNonEmptyString(payload, "id", command);
  requireForeshadowBaseVersion(payload, command);
  return payload;
}

function requireForeshadowAssociationPayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireForeshadowPayload(args, command);
  requireForeshadowRendererAuthority(payload, command, ["human-direct"]);
  requireNonEmptyString(payload, "foreshadowId", command);
  requireNonEmptyString(payload, "codexId", command);
  requireForeshadowBaseVersion(payload, command);
  return payload;
}

function requireForeshadowSetupStrengthPayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireForeshadowPayload(args, command);
  requireForeshadowRendererAuthority(payload, command, ["human-direct"]);
  requireNonEmptyString(payload, "setupId", command);
  requirePresent(payload, "strength", command);
  if (payload.strength !== null && typeof payload.strength !== "string") {
    throw new Error(
      `invalid args \`strength\` for command \`${command}\`: expected a string or null`,
    );
  }
  requireForeshadowBaseVersion(payload, command);
  return payload;
}

function requireForeshadowBaseVersion(
  args: CommandArgs,
  command: string,
): number {
  const baseVersion = requireSafeInteger(args, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return baseVersion;
}

function requireAgentForeshadowUpdatePayload(args: CommandArgs): CommandArgs {
  const command = "agent_foreshadow_update";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "interactive-agent-command",
  ]);
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "sessionId", command);
  requireNonEmptyString(payload, "foreshadowId", command);
  requireForeshadowBaseVersion(payload, command);
  return payload;
}

function requireAgentForeshadowCreatePayload(args: CommandArgs): CommandArgs {
  const command = "agent_foreshadow_create";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "interactive-agent-command",
  ]);
  requireNonEmptyString(payload, "foreshadowId", command);
  requireNonEmptyString(payload, "title", command);
  return payload;
}

function requireCanonicalAgentCreatePayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireCanonicalWriterIdentity(args, command, [
    "interactive-agent-command",
  ]);
  for (const key of ["projectId", "requestId", "sessionId"]) {
    requireNonEmptyString(payload, key, command);
  }
  return payload;
}

function requireForeshadowAnchorPayloads(
  args: CommandArgs,
  command: string,
): { setups: unknown[]; payoffs: unknown[]; baseVersions: CommandArgs } {
  const setups = requireArray(args, "setups", command);
  const payoffs = requireArray(args, "payoffs", command);
  const baseVersions = requireRecord(args, "baseVersions", command);
  for (const [foreshadowId, value] of Object.entries(baseVersions)) {
    if (
      foreshadowId.length === 0 ||
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(
        `invalid args \`baseVersions.${foreshadowId}\` for command \`${command}\``,
      );
    }
  }
  setups.forEach((item, index) => {
    const prefix = `setups[${index}]`;
    const setup = requireSceneBundleRecord(item, prefix, command);
    requireNonEmptyString(setup, "foreshadowId", command);
    const baseVersion = requireSafeInteger(setup, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`${prefix}.baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  });
  payoffs.forEach((item, index) => {
    const prefix = `payoffs[${index}]`;
    const payoff = requireSceneBundleRecord(item, prefix, command);
    requireNonEmptyString(payoff, "foreshadowId", command);
    const baseVersion = requireSafeInteger(payoff, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`${prefix}.baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  });
  return { setups, payoffs, baseVersions };
}

function requireNonEmptyString(
  args: CommandArgs,
  key: string,
  command: string,
): string {
  const value = requireString(args, key, command);
  if (value.length === 0) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a non-empty string`,
    );
  }
  return value;
}

function requireSafeInteger(
  args: CommandArgs,
  key: string,
  command: string,
): number {
  const value = requireNumber(args, key, command);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a safe integer`,
    );
  }
  return value;
}

function requireTimelapseGenesisBaselinesAppendArgs(args: CommandArgs): {
  expectedWorkspacePath: string;
  projectId: string;
  kind: "scene" | "codex" | "snippet";
  entityIds: string[];
  anchorTimestamp: number;
} {
  const command = "timelapse_genesis_baselines_append";
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "kind",
    "entityIds",
    "anchorTimestamp",
  ]);
  if (
    Object.keys(args).length !== allowedKeys.size ||
    Object.keys(args).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly expectedWorkspacePath, projectId, kind, entityIds, anchorTimestamp`,
    );
  }

  const exactBoundedString = (key: string, maxLength: number): string => {
    const value = requireNonEmptyString(args, key, command);
    if (value !== value.trim() || value.length > maxLength) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected an exact non-empty string of at most ${maxLength} characters`,
      );
    }
    return value;
  };
  const expectedWorkspacePath = exactBoundedString(
    "expectedWorkspacePath",
    16_384,
  );
  const projectId = exactBoundedString("projectId", 512);
  const kindValue = requireString(args, "kind", command);
  if (
    kindValue !== "scene" &&
    kindValue !== "codex" &&
    kindValue !== "snippet"
  ) {
    throw new Error(
      `invalid args \`kind\` for command \`${command}\`: expected scene, codex, or snippet`,
    );
  }
  const rawEntityIds = requireArray(args, "entityIds", command);
  if (rawEntityIds.length < 1 || rawEntityIds.length > 64) {
    throw new Error(
      `invalid args \`entityIds\` for command \`${command}\`: expected 1..64 items`,
    );
  }
  const entityIds = rawEntityIds.map((value, index) => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value !== value.trim() ||
      value.length > 512
    ) {
      throw new Error(
        `invalid args \`entityIds[${index}]\` for command \`${command}\`: expected an exact non-empty string of at most 512 characters`,
      );
    }
    return value;
  });
  if (new Set(entityIds).size !== entityIds.length) {
    throw new Error(
      `invalid args \`entityIds\` for command \`${command}\`: duplicate ids are not allowed`,
    );
  }
  const anchorTimestamp = requireSafeInteger(args, "anchorTimestamp", command);
  if (anchorTimestamp < 0) {
    throw new Error(
      `invalid args \`anchorTimestamp\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return {
    expectedWorkspacePath,
    projectId,
    kind: kindValue,
    entityIds,
    anchorTimestamp,
  };
}

function requireTimelapseBodyBaselinesAppendArgs(args: CommandArgs): {
  expectedWorkspacePath: string;
  projectId: string;
  targets: Array<{ kind: "scene" | "codex" | "snippet"; id: string }>;
  expectedAnchorSequence: number | null;
} {
  const command = "timelapse_body_baselines_append";
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "targets",
    "expectedAnchorSequence",
  ]);
  if (
    Object.keys(args).length !== allowedKeys.size ||
    Object.keys(args).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly expectedWorkspacePath, projectId, targets, expectedAnchorSequence`,
    );
  }
  const exactBoundedString = (key: string, maxLength: number): string => {
    const value = requireNonEmptyString(args, key, command);
    if (value !== value.trim() || value.length > maxLength) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected an exact non-empty string of at most ${maxLength} characters`,
      );
    }
    return value;
  };
  const expectedWorkspacePath = exactBoundedString(
    "expectedWorkspacePath",
    16_384,
  );
  const projectId = exactBoundedString("projectId", 512);
  const rawTargets = requireArray(args, "targets", command);
  if (rawTargets.length < 1 || rawTargets.length > 64) {
    throw new Error(
      `invalid args \`targets\` for command \`${command}\`: expected 1..64 items`,
    );
  }
  const seen = new Set<string>();
  const targets = rawTargets.map((value, index) => {
    const key = `targets[${index}]`;
    const target = requireRecord({ value }, "value", command);
    const targetKeys = Object.keys(target);
    if (
      targetKeys.length !== 2 ||
      !Object.hasOwn(target, "kind") ||
      !Object.hasOwn(target, "id")
    ) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected exactly kind and id`,
      );
    }
    const kind = requireString(target, "kind", command);
    if (kind !== "scene" && kind !== "codex" && kind !== "snippet") {
      throw new Error(
        `invalid args \`${key}.kind\` for command \`${command}\`: expected scene, codex, or snippet`,
      );
    }
    const id = requireNonEmptyString(target, "id", command);
    if (id !== id.trim() || id.length > 512) {
      throw new Error(
        `invalid args \`${key}.id\` for command \`${command}\`: expected an exact non-empty string of at most 512 characters`,
      );
    }
    const identity = `${kind}\u0000${id}`;
    if (seen.has(identity)) {
      throw new Error(
        `invalid args \`targets\` for command \`${command}\`: duplicate identities are not allowed`,
      );
    }
    seen.add(identity);
    return {
      kind: kind as "scene" | "codex" | "snippet",
      id,
    };
  });
  const rawAnchor = requirePresent(args, "expectedAnchorSequence", command);
  if (
    rawAnchor !== null &&
    (typeof rawAnchor !== "number" ||
      !Number.isSafeInteger(rawAnchor) ||
      rawAnchor < 0)
  ) {
    throw new Error(
      `invalid args \`expectedAnchorSequence\` for command \`${command}\`: expected a non-negative safe integer or null`,
    );
  }
  return {
    expectedWorkspacePath,
    projectId,
    targets,
    expectedAnchorSequence: rawAnchor as number | null,
  };
}

function requireTimelapseHistoryPurgeArgs(args: CommandArgs): {
  expectedWorkspacePath: string;
  projectId: string;
} {
  const command = "timelapse_history_purge";
  const allowedKeys = new Set(["expectedWorkspacePath", "projectId"]);
  if (
    Object.keys(args).length !== allowedKeys.size ||
    Object.keys(args).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly expectedWorkspacePath, projectId`,
    );
  }
  const expectedWorkspacePath = requireNonEmptyString(
    args,
    "expectedWorkspacePath",
    command,
  );
  const projectId = requireNonEmptyString(args, "projectId", command);
  if (
    expectedWorkspacePath.trim() !== expectedWorkspacePath ||
    expectedWorkspacePath.length > 16_384 ||
    projectId.trim() !== projectId ||
    projectId.length > 512
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: workspacePath and projectId must be exact bounded strings`,
    );
  }
  return { expectedWorkspacePath, projectId };
}

function requireTimelapseEnabledSetArgs(args: CommandArgs): {
  expectedWorkspacePath: string;
  projectId: string;
  enabled: boolean;
} {
  const command = "timelapse_enabled_set";
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "enabled",
  ]);
  if (
    Object.keys(args).length !== allowedKeys.size ||
    Object.keys(args).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly expectedWorkspacePath, projectId, enabled`,
    );
  }
  const expectedWorkspacePath = requireNonEmptyString(
    args,
    "expectedWorkspacePath",
    command,
  );
  const projectId = requireNonEmptyString(args, "projectId", command);
  if (
    expectedWorkspacePath.trim() !== expectedWorkspacePath ||
    expectedWorkspacePath.length > 16_384 ||
    projectId.trim() !== projectId ||
    projectId.length > 512
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: workspacePath and projectId must be exact bounded strings`,
    );
  }
  return {
    expectedWorkspacePath,
    projectId,
    enabled: requireBoolean(args, "enabled", command),
  };
}

function requireTimelapseLayoutSnapshotRecordArgs(args: CommandArgs): {
  expectedWorkspacePath: string;
  projectId: string;
  payload: CommandArgs;
  expectedAnchorSequence: number | null;
} {
  const command = "timelapse_layout_snapshot_record";
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "payload",
    "expectedAnchorSequence",
  ]);
  if (
    Object.keys(args).length !== allowedKeys.size ||
    Object.keys(args).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly expectedWorkspacePath, projectId, payload, expectedAnchorSequence`,
    );
  }
  const expectedWorkspacePath = requireNonEmptyString(
    args,
    "expectedWorkspacePath",
    command,
  );
  const projectId = requireNonEmptyString(args, "projectId", command);
  if (
    expectedWorkspacePath.trim() !== expectedWorkspacePath ||
    expectedWorkspacePath.length > 16_384 ||
    projectId.trim() !== projectId ||
    projectId.length > 512
  ) {
    throw new Error(
      `invalid args for command \`${command}\`: workspacePath and projectId must be exact bounded strings`,
    );
  }
  const payload = requireRecord(args, "payload", command);
  const payloadKeys = new Set(["layout", "activePresetId", "hiddenStripePanels"]);
  if (
    !Object.hasOwn(payload, "layout") ||
    Object.keys(payload).some((key) => !payloadKeys.has(key))
  ) {
    throw new Error(
      `invalid args \`payload\` for command \`${command}\`: expected layout plus optional activePresetId/hiddenStripePanels`,
    );
  }
  requireRecord(payload, "layout", command);
  if (Object.hasOwn(payload, "activePresetId")) {
    nullableString(payload, "activePresetId", command);
  }
  if (Object.hasOwn(payload, "hiddenStripePanels")) {
    const panels = requireArray(payload, "hiddenStripePanels", command);
    if (panels.length > 128 || panels.some((panel) => typeof panel !== "string")) {
      throw new Error(
        `invalid args \`payload.hiddenStripePanels\` for command \`${command}\`: expected at most 128 strings`,
      );
    }
  }
  const rawAnchor = requirePresent(args, "expectedAnchorSequence", command);
  if (
    rawAnchor !== null &&
    (typeof rawAnchor !== "number" ||
      !Number.isSafeInteger(rawAnchor) ||
      rawAnchor < 0)
  ) {
    throw new Error(
      `invalid args \`expectedAnchorSequence\` for command \`${command}\`: expected a non-negative safe integer or null`,
    );
  }
  return {
    expectedWorkspacePath,
    projectId,
    payload,
    expectedAnchorSequence: rawAnchor as number | null,
  };
}

/** OCC トークンや件数など「0 以上の整数」必須フィールド用。 */
function requireNonNegativeSafeInteger(
  args: CommandArgs,
  key: string,
  command: string,
): number {
  const value = requireNumber(args, key, command);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  return value;
}

export const AI_AUDIT_EVENT_TYPES = [
  "execution.started",
  "request.prepared",
  "request.dispatched",
  "transport.attempt.started",
  "transport.attempt.finished",
  "response.partial",
  "response.completed",
  "execution.succeeded",
  "execution.failed",
  "execution.cancelled",
  "execution.skipped",
  "execution.cache_hit",
  "execution.retrying",
  "execution.fallback",
] as const;

const AI_AUDIT_EVENT_TYPE_SET = new Set<string>(AI_AUDIT_EVENT_TYPES);
const AI_AUDIT_CAPTURE_STATES = new Set([
  "complete",
  "partial",
  "redacted",
  "truncated",
  "legacy_missing",
  "unobservable_provider",
]);

function normalizedAuditPayloadKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function segmentedAuditPayloadKey(key: string): string {
  return key
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

const AI_AUDIT_STRONG_CREDENTIAL_KEY_MARKERS = [
  "authorization",
  "authentication",
  "headers",
  "cookie",
  "environment",
  "apikey",
  "accesstoken",
  "bearer",
  "accesskeyid",
  "secretaccesskey",
  "privatekey",
  "password",
  "passwd",
] as const;

function hasAuditCredentialMarkerAtKeyBoundary(
  normalized: string,
  marker: string,
): boolean {
  return (
    normalized === marker ||
    normalized.startsWith(marker) ||
    normalized.endsWith(marker)
  );
}

function isForbiddenAuditPayloadKey(key: string): boolean {
  const normalized = normalizedAuditPayloadKey(key);
  const segmented = segmentedAuditPayloadKey(key);
  const segments = segmented ? segmented.split("_") : [];
  if (
    normalized === "auth" ||
    normalized.endsWith("auth") ||
    segments.includes("auth")
  ) {
    return true;
  }
  if (
    AI_AUDIT_STRONG_CREDENTIAL_KEY_MARKERS.some((marker) =>
      hasAuditCredentialMarkerAtKeyBoundary(normalized, marker),
    )
  ) {
    return true;
  }
  if (
    normalized === "env" ||
    normalized.startsWith("environment") ||
    normalized.startsWith("processenv") ||
    normalized.endsWith("env")
  ) {
    return true;
  }
  if (
    normalized === "secret" ||
    normalized.startsWith("secret") ||
    normalized.endsWith("secret")
  ) {
    return true;
  }
  return (
    normalized === "token" ||
    normalized.endsWith("token") ||
    (normalized.startsWith("token") &&
      !/^(?:tokens|(?:token|tokens)(?:usage|count|counts|budget|limit|limits|estimate|estimated|total|totals|used|remaining|input|output|cached|reasoning|billable))$/u.test(
        normalized,
      ))
  );
}

type AiAuditJsonPathSegment = string | number;

function isAiVisibleAuditPath(
  eventType: string,
  path: readonly AiAuditJsonPathSegment[],
): boolean {
  if (
    eventType === "request.prepared" &&
    path.length === 1 &&
    path[0] === "input"
  ) {
    return true;
  }
  if (eventType === "request.prepared" && path[0] === "request") {
    if (
      path.length === 2 &&
      ["body", "input", "tools", "modelVisibleContext"].includes(
        String(path[1]),
      )
    ) {
      return true;
    }
    return (
      path.length === 3 && path[1] === "messages" && typeof path[2] === "number"
    );
  }
  return (
    path.length === 1 &&
    path[0] === "response" &&
    (eventType === "response.partial" ||
      eventType === "response.completed" ||
      eventType === "execution.cache_hit")
  );
}

function isAiAuditVisibilityResetPath(
  eventType: string,
  path: readonly AiAuditJsonPathSegment[],
): boolean {
  return (
    eventType === "response.partial" &&
    path.length === 2 &&
    path[0] === "response" &&
    path[1] === "runtimeDiagnostic"
  );
}

function validateAuditJsonValue(
  value: unknown,
  command: string,
  path: string,
  eventType: string,
  jsonPath: readonly AiAuditJsonPathSegment[] = [],
  seen = new WeakSet<object>(),
  aiVisibleContent = false,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(
      `invalid args \`${path}\` for command \`${command}\`: expected finite JSON number`,
    );
  }
  if (typeof value !== "object") {
    throw new Error(
      `invalid args \`${path}\` for command \`${command}\`: expected JSON-compatible value`,
    );
  }
  if (seen.has(value)) {
    throw new Error(
      `invalid args \`${path}\` for command \`${command}\`: cyclic JSON value`,
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const childPath = [...jsonPath, index];
      validateAuditJsonValue(
        item,
        command,
        `${path}[${index}]`,
        eventType,
        childPath,
        seen,
        aiVisibleContent || isAiVisibleAuditPath(eventType, childPath),
      );
    });
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (!aiVisibleContent && isForbiddenAuditPayloadKey(key)) {
        throw new Error(
          `invalid args \`${path}.${key}\` for command \`${command}\`: credential and transport-header keys are excluded from AI audit payloads`,
        );
      }
      const childPath = [...jsonPath, key];
      const childAiVisible = isAiAuditVisibilityResetPath(eventType, childPath)
        ? false
        : aiVisibleContent || isAiVisibleAuditPath(eventType, childPath);
      validateAuditJsonValue(
        item,
        command,
        `${path}.${key}`,
        eventType,
        childPath,
        seen,
        childAiVisible,
      );
    }
  }
  seen.delete(value);
}

function optionalNonNegativeSafeInteger(
  args: CommandArgs,
  key: string,
  command: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a non-negative safe integer or null`,
    );
  }
  return value as number;
}

function requireAiAuditProjectId(
  args: CommandArgs,
  command: string,
): string | null {
  const projectId = requirePresent(args, "projectId", command);
  if (projectId === null) return null;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new Error(
      `invalid args \`projectId\` for command \`${command}\`: expected a non-empty string or null`,
    );
  }
  if (projectId !== projectId.trim()) {
    throw new Error(
      `invalid args \`projectId\` for command \`${command}\`: surrounding whitespace is not allowed`,
    );
  }
  return projectId;
}

function optionalAiAuditPageLimit(
  args: CommandArgs,
  command: string,
): number | undefined {
  const limit = optionalNonNegativeSafeInteger(args, "limit", command);
  if (limit !== undefined && (limit < 1 || limit > 1_000)) {
    throw new Error(
      `invalid args \`limit\` for command \`${command}\`: expected 1..1000`,
    );
  }
  return limit;
}

function validateAiAuditRedactions(
  payload: CommandArgs,
  command: string,
  eventIndex: number,
): void {
  if (payload.redactions === undefined) return;
  if (!Array.isArray(payload.redactions)) {
    throw new Error(
      `invalid args \`events[${eventIndex}].payload.redactions\` for command \`${command}\`: expected an array`,
    );
  }
  const allowedKeys = new Set([
    "path",
    "category",
    "ruleId",
    "originalSha256",
    "originalByteLength",
    "placeholder",
    "reversible",
  ]);
  payload.redactions.forEach((candidate, redactionIndex) => {
    const path = `events[${eventIndex}].payload.redactions[${redactionIndex}]`;
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        `invalid args \`${path}\` for command \`${command}\`: expected an object`,
      );
    }
    const record = candidate as CommandArgs;
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
      throw new Error(
        `invalid args \`${path}\` for command \`${command}\`: unexpected redaction key`,
      );
    }
    const redactionPath = requireNonEmptyString(record, "path", command);
    const ruleId = requireNonEmptyString(record, "ruleId", command);
    const sha256 = requireNonEmptyString(record, "originalSha256", command);
    const originalByteLength = requireSafeInteger(
      record,
      "originalByteLength",
      command,
    );
    if (
      redactionPath.length === 0 ||
      ruleId.length === 0 ||
      !/^[0-9a-f]{64}$/u.test(sha256) ||
      originalByteLength < 0 ||
      record.category !== "credential" ||
      record.placeholder !== "[REDACTED:credential]" ||
      record.reversible !== false
    ) {
      throw new Error(
        `invalid args \`${path}\` for command \`${command}\`: invalid irreversible credential redaction record`,
      );
    }
  });
}

function requireAiAuditEvents(args: CommandArgs): CommandArgs[] {
  const command = "ai_audit_append_batch";
  const value = requirePresent(args, "events", command);
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(
      `invalid args \`events\` for command \`${command}\`: expected 1..256 events`,
    );
  }
  const allowedKeys = new Set([
    "eventId",
    "executionId",
    "operationId",
    "parentExecutionId",
    "pathId",
    "eventType",
    "timestamp",
    "payload",
  ]);
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        `invalid args \`events[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const event = candidate as CommandArgs;
    if (Object.keys(event).some((key) => !allowedKeys.has(key))) {
      throw new Error(
        `invalid args \`events[${index}]\` for command \`${command}\`: unexpected key`,
      );
    }
    for (const key of [
      "eventId",
      "executionId",
      "operationId",
      "pathId",
      "eventType",
    ]) {
      requireNonEmptyString(event, key, command);
    }
    const parentExecutionId = event.parentExecutionId;
    if (
      parentExecutionId !== undefined &&
      parentExecutionId !== null &&
      (typeof parentExecutionId !== "string" || parentExecutionId.length === 0)
    ) {
      throw new Error(
        `invalid args \`parentExecutionId\` for command \`${command}\`: expected a non-empty string or null`,
      );
    }
    const eventType = event.eventType as string;
    if (!AI_AUDIT_EVENT_TYPE_SET.has(eventType)) {
      throw new Error(
        `invalid args \`eventType\` for command \`${command}\`: unsupported AI audit event type`,
      );
    }
    const timestamp = requireSafeInteger(event, "timestamp", command);
    if (timestamp < 0) {
      throw new Error(
        `invalid args \`timestamp\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
    const payload = requireRecord(event, "payload", command);
    const captureState = requireNonEmptyString(
      payload,
      "captureState",
      command,
    );
    if (!AI_AUDIT_CAPTURE_STATES.has(captureState)) {
      throw new Error(
        `invalid args \`captureState\` for command \`${command}\`: unsupported capture state`,
      );
    }
    if (
      eventType === "request.prepared" &&
      payload.credentialsExcluded !== true
    ) {
      throw new Error(
        `invalid args \`credentialsExcluded\` for command \`${command}\`: request.prepared requires true`,
      );
    }
    validateAiAuditRedactions(payload, command, index);
    validateAuditJsonValue(
      payload,
      command,
      `events[${index}].payload`,
      eventType,
    );
    return event;
  });
}

function requireLintIgnoreCreatePayload(args: CommandArgs): CommandArgs {
  const command = "lint_ignore_create";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["id", "projectId", "sceneId", "ruleId"]) {
    requireNonEmptyString(payload, key, command);
  }
  for (const key of ["textSnippet", "contextBefore", "contextAfter"]) {
    requireString(payload, key, command);
  }
  const note = requirePresent(payload, "note", command);
  if (note !== null && typeof note !== "string") {
    throw new Error(
      `invalid args \`note\` for command \`${command}\`: expected a string or null`,
    );
  }
  const createdAt = requireNumber(payload, "createdAt", command);
  if (!Number.isSafeInteger(createdAt)) {
    throw new Error(
      `invalid args \`createdAt\` for command \`${command}\`: expected a safe integer`,
    );
  }
  return payload;
}

function requireEditorStickyCreatePayload(args: CommandArgs): CommandArgs {
  const command = "editor_sticky_create";
  const payload = requireRecord(args, "payload", command);
  if (Object.hasOwn(payload, "id")) {
    requireNonEmptyString(payload, "id", command);
  }
  for (const key of ["projectId", "documentKey", "body", "paletteId"]) {
    requireNonEmptyString(payload, key, command);
  }
  for (const key of ["inlineOffset", "blockOffset"]) {
    requireNumber(payload, key, command);
  }
  for (const key of ["colorSlot", "zIndex"]) {
    requireSafeInteger(payload, key, command);
  }
  return payload;
}

function requireEditorStickyUpdatePayload(args: CommandArgs): CommandArgs {
  const command = "editor_sticky_update";
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "stickyId", command);
  requireSafeInteger(payload, "baseVersion", command);
  const patch = requireRecord(payload, "patch", command);
  if (Object.hasOwn(patch, "body")) {
    requireNonEmptyString(patch, "body", command);
  }
  if (Object.hasOwn(patch, "paletteId")) {
    requireNonEmptyString(patch, "paletteId", command);
  }
  for (const key of ["inlineOffset", "blockOffset"]) {
    if (Object.hasOwn(patch, key)) requireNumber(patch, key, command);
  }
  for (const key of ["colorSlot", "zIndex"]) {
    if (Object.hasOwn(patch, key)) requireSafeInteger(patch, key, command);
  }
  return payload;
}

function requireEditorStickyDeletePayload(args: CommandArgs): CommandArgs {
  const command = "editor_sticky_delete";
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "stickyId", command);
  requireSafeInteger(payload, "baseVersion", command);
  return payload;
}

function requireLintIgnoreCopyPayload(args: CommandArgs): CommandArgs {
  const command = "lint_ignore_copy";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["projectId", "fromSceneId", "toSceneId"]) {
    requireNonEmptyString(payload, key, command);
  }
  return payload;
}

function requireLintIgnoreMovePayload(args: CommandArgs): CommandArgs {
  const command = "lint_ignore_move";
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "toSceneId", command);
  const fromSceneIds = requireArray(payload, "fromSceneIds", command);
  fromSceneIds.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid args \`fromSceneIds[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return payload;
}

function requireLintTermDictionaryPayload(
  args: CommandArgs,
  command: "lint_term_dictionary_insert" | "lint_term_dictionary_update",
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  for (const key of ["id", "projectId", "preferred"]) {
    requireNonEmptyString(payload, key, command);
  }
  const variants = requireArray(payload, "variants", command);
  if (variants.length === 0) {
    throw new Error(
      `invalid args \`variants\` for command \`${command}\`: expected at least one string`,
    );
  }
  variants.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid args \`variants[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  const severity = requireString(payload, "severity", command);
  if (severity !== "warning" && severity !== "info") {
    throw new Error(
      `invalid args \`severity\` for command \`${command}\`: expected warning or info`,
    );
  }
  const note = requirePresent(payload, "note", command);
  if (note !== null && typeof note !== "string") {
    throw new Error(
      `invalid args \`note\` for command \`${command}\`: expected a string or null`,
    );
  }
  requireBoolean(payload, "enabled", command);
  const integerKeys =
    command === "lint_term_dictionary_insert"
      ? (["sortOrder", "createdAt", "updatedAt"] as const)
      : (["updatedAt"] as const);
  for (const key of integerKeys) {
    requireSafeInteger(payload, key, command);
  }
  return payload;
}

function requireEventSetParticipantsPayload(args: CommandArgs): CommandArgs {
  const command = "event_set_participants";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["requestId", "sessionId", "eventUid"] as const) {
    requireNonEmptyString(payload, key, command);
  }
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "eventId", command);
  requireNonEmptyString(payload, "updatedAt", command);
  const baseVersion = requireSafeInteger(payload, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  requireArray(payload, "codexEntryIds", command).forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid args \`codexEntryIds[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return payload;
}

function requireProjectCalendarUpsertPayload(args: CommandArgs): CommandArgs {
  const command = "project_calendar_upsert";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["requestId", "sessionId", "eventUid"] as const) {
    requireNonEmptyString(payload, key, command);
  }
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "updatedAt", command);
  for (const key of [
    "seasonBoundaries",
    "months",
    "weekdayNames",
    "leapRule",
    "ageReckoning",
    "eras",
    "reform",
    "timezone",
  ] as const) {
    requireString(payload, key, command);
  }
  for (const key of [
    "daysPerYear",
    "startYear",
    "weekdayStartIndex",
    "lunarTzMinutes",
  ] as const) {
    requireSafeInteger(payload, key, command);
  }
  if (payload.baseVersion !== undefined && payload.baseVersion !== null) {
    const baseVersion = requireSafeInteger(payload, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer when present`,
      );
    }
  } else if (payload.baseVersion === undefined) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: missing required key baseVersion`,
    );
  }
  return payload;
}

function requireNullableStringField(
  args: CommandArgs,
  key: string,
  command: string,
): string | null {
  const value = requirePresent(args, key, command);
  if (value !== null && typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a string or null`,
    );
  }
  return value;
}

function requireCanonicalWriterIdentity(
  args: CommandArgs,
  command: string,
  allowedRoutes?: readonly string[],
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  for (const key of ["projectId", "requestId", "sessionId", "eventUid"]) {
    requireNonEmptyString(payload, key, command);
  }
  const origin = requireString(payload, "origin", command);
  if (
    ![
      "human",
      "ai-apply",
      "import",
      "undo",
      "redo",
      "restore",
      "migration",
    ].includes(origin)
  ) {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: expected a supported Change Feed origin`,
    );
  }
  const originalTransactionId = requireNullableStringField(
    payload,
    "originalTransactionId",
    command,
  );
  const undoJournalId = requireNullableStringField(
    payload,
    "undoJournalId",
    command,
  );
  const replay = origin === "undo" || origin === "redo";
  if (
    replay !==
      (Boolean(originalTransactionId?.length) &&
        Boolean(undoJournalId?.length)) ||
    (!replay && (originalTransactionId !== null || undoJournalId !== null))
  ) {
    throw new Error(
      `invalid canonical lineage for command \`${command}\`: undo/redo requires originalTransactionId and undoJournalId`,
    );
  }
  requireCanonicalAuthorityContext(payload, command);
  if (
    allowedRoutes &&
    !allowedRoutes.includes(String(payload.authorityRoute))
  ) {
    throw new Error(
      `invalid authority route for command \`${command}\`: ${String(payload.authorityRoute)} is not allowed`,
    );
  }
  return payload;
}

const CANONICAL_AUTHORITY_POLICIES = {
  "human-direct": {
    allowedOrigins: ["human"],
    allowedCallers: ["human-ui", "manual-wrapper", "typed-domain-api"],
    requiredControls: [
      "runtime-policy",
      "actor-context",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
  },
  "interactive-agent-command": {
    allowedOrigins: ["ai-apply"],
    allowedCallers: [
      "chat-tool-executor",
      "manual-wrapper",
      "registered-agent-surface",
    ],
    requiredControls: [
      "knowledge-write-policy",
      "stable-request-id",
      "agent-provenance",
      "field-authority",
      "typed-writer",
      "occ",
      "undo-journal",
      "change-event",
      "change-feed",
    ],
  },
  "interpreter-projection": {
    allowedOrigins: ["ai-apply"],
    allowedCallers: [
      "interpreter",
      "reconciler",
      "proposal-review",
      "prepared-commit-runner",
    ],
    requiredControls: [
      "proposal-revision",
      "decision",
      "prepared-commit",
      "application-id",
      "source-basis-occ",
      "field-authority",
      "typed-writer",
    ],
  },
  "import-apply": {
    allowedOrigins: ["import"],
    allowedCallers: ["import-session", "import-review"],
    requiredControls: [
      "import-policy",
      "source-package-evidence",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
  },
  "history-replay": {
    allowedOrigins: ["undo", "redo"],
    allowedCallers: ["history-controller", "undo-redo-command"],
    requiredControls: [
      "original-transaction",
      "journal-lineage",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
  },
  "restore-or-migration": {
    allowedOrigins: ["restore", "migration"],
    allowedCallers: [
      "restore-controller",
      "migration-runner",
      "integrity-repair",
    ],
    requiredControls: [
      "exclusive-system-operation",
      "semantic-epoch-event",
      "full-rebuild-marker",
    ],
  },
} as const;

export type CanonicalAuthorityRoute = keyof typeof CANONICAL_AUTHORITY_POLICIES;

const KNOWN_CANONICAL_AUTHORITY_CONTROLS = new Set([
  "runtime-policy",
  "actor-context",
  "knowledge-write-policy",
  "stable-request-id",
  "agent-provenance",
  "typed-writer",
  "occ",
  "source-basis-occ",
  "field-authority",
  "proposal-revision",
  "decision",
  "prepared-commit",
  "application-id",
  "undo-journal",
  "journal-lineage",
  "original-transaction",
  "change-event",
  "change-feed",
  "import-policy",
  "source-package-evidence",
  "exclusive-system-operation",
  "semantic-epoch-event",
  "full-rebuild-marker",
]);

function requireCanonicalAuthorityContext(
  payload: CommandArgs,
  command: string,
): void {
  const route = requireNonEmptyString(payload, "authorityRoute", command);
  const policy =
    CANONICAL_AUTHORITY_POLICIES[
      route as keyof typeof CANONICAL_AUTHORITY_POLICIES
    ];
  if (!policy) {
    throw new Error(
      `invalid args \`authorityRoute\` for command \`${command}\`: unknown mutation authority route`,
    );
  }
  const origin = requireString(payload, "origin", command);
  if (!policy.allowedOrigins.includes(origin as never)) {
    throw new Error(
      `invalid authority origin for command \`${command}\`: ${origin} is not valid for ${route}`,
    );
  }
  const caller = requireNonEmptyString(payload, "caller", command);
  if (!policy.allowedCallers.includes(caller as never)) {
    throw new Error(
      `invalid authority caller for command \`${command}\`: ${caller} is not allowed for ${route}`,
    );
  }
  const controls = requireArray(payload, "controls", command);
  controls.forEach((control, index) => {
    if (typeof control !== "string" || control.length === 0) {
      throw new Error(
        `invalid args \`controls[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
    if (!KNOWN_CANONICAL_AUTHORITY_CONTROLS.has(control)) {
      throw new Error(
        `invalid authority control for command \`${command}\`: unknown control ${control}`,
      );
    }
  });
  for (const control of policy.requiredControls) {
    if (!controls.includes(control)) {
      throw new Error(
        `invalid authority controls for command \`${command}\`: missing ${control}`,
      );
    }
  }
  if (Object.hasOwn(payload, "writesAuthorityProtectedField")) {
    const protectedField = requireBoolean(
      payload,
      "writesAuthorityProtectedField",
      command,
    );
    if (protectedField && !controls.includes("field-authority")) {
      throw new Error(
        `invalid authority controls for command \`${command}\`: protected-field writes require field-authority`,
      );
    }
  }
  if (route === "interactive-agent-command") {
    const provenance = requireRecord(payload, "provenance", command);
    requireNonEmptyString(provenance, "requestId", command);
    requireNonEmptyString(provenance, "traceId", command);
    if (Object.hasOwn(provenance, "executionId")) {
      requireNonEmptyString(provenance, "executionId", command);
    }
    if (Object.hasOwn(provenance, "mainOwnedProvenanceId")) {
      requireNonEmptyString(provenance, "mainOwnedProvenanceId", command);
      if (!Object.hasOwn(provenance, "executionId")) {
        throw new Error(
          `invalid authority provenance for command \`${command}\`: mainOwnedProvenanceId requires executionId`,
        );
      }
    }
    if (provenance.requestId !== payload.requestId) {
      throw new Error(
        `invalid authority provenance for command \`${command}\`: requestId must match canonical requestId`,
      );
    }
  }
}

/**
 * Bind the authority fields at the Electron main boundary. Renderer payloads
 * may carry request/session/event identity, but route, caller, controls, and
 * agent provenance are selected by the main-owned command policy rather than
 * copied from renderer metadata.
 */
export function bindCanonicalAuthorityContext(
  payload: CommandArgs,
  route: CanonicalAuthorityRoute,
): CommandArgs {
  const policy = CANONICAL_AUTHORITY_POLICIES[route];
  const requestedOrigin = payload.origin;
  const origin = policy.allowedOrigins.includes(requestedOrigin as never)
    ? requestedOrigin
    : policy.allowedOrigins[0];
  const requestId =
    typeof payload.requestId === "string" ? payload.requestId : "";
  const eventUid =
    typeof payload.eventUid === "string" && payload.eventUid.trim().length > 0
      ? payload.eventUid
      : requestId;
  const originalTransactionId =
    typeof payload.originalTransactionId === "string" &&
    payload.originalTransactionId.trim().length > 0
      ? payload.originalTransactionId
      : null;
  const undoJournalId =
    typeof payload.undoJournalId === "string" &&
    payload.undoJournalId.trim().length > 0
      ? payload.undoJournalId
      : null;
  const caller =
    route === "restore-or-migration" && origin === "migration"
      ? "migration-runner"
      : policy.allowedCallers[0];
  const traceId =
    typeof payload.traceId === "string" && payload.traceId.trim().length > 0
      ? payload.traceId
      : requestId;
  const chatMessageId =
    typeof payload.chatMessageId === "string" &&
    payload.chatMessageId.trim().length > 0
      ? payload.chatMessageId
      : undefined;
  const toolCallId =
    typeof payload.toolCallId === "string" &&
    payload.toolCallId.trim().length > 0
      ? payload.toolCallId
      : undefined;
  const executionId =
    typeof payload.executionId === "string" &&
    payload.executionId.trim().length > 0
      ? payload.executionId
      : undefined;
  const mainOwnedProvenanceId =
    typeof payload.mainOwnedProvenanceId === "string" &&
    payload.mainOwnedProvenanceId.trim().length > 0
      ? payload.mainOwnedProvenanceId
      : undefined;
  return {
    ...payload,
    eventUid,
    originalTransactionId,
    undoJournalId,
    origin,
    authorityRoute: route,
    caller,
    controls: [...policy.requiredControls],
    provenance:
      route === "interactive-agent-command"
        ? {
            requestId,
            traceId,
            ...(chatMessageId ? { chatMessageId } : {}),
            ...(toolCallId ? { toolCallId } : {}),
            ...(executionId ? { executionId } : {}),
            ...(mainOwnedProvenanceId ? { mainOwnedProvenanceId } : {}),
          }
        : null,
    writesAuthorityProtectedField: false,
  };
}

function requireSnippetWriterPayload(
  args: CommandArgs,
  command: "snippet_create" | "snippet_update" | "snippet_delete",
): CommandArgs {
  const rawPayload = requireRecord(args, "payload", command);
  if (rawPayload.origin === "undo" || rawPayload.origin === "redo") {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: Snippet history must replay its Native Undo Journal`,
    );
  }

  const payload = requireCanonicalWriterIdentity(
    args,
    command,
    command === "snippet_create"
      ? ["human-direct", "import-apply", "restore-or-migration"]
      : ["human-direct"],
  );
  requireNonEmptyString(payload, "snippetId", command);

  if (command === "snippet_create") {
    requireString(payload, "title", command);
    requireString(payload, "content", command);
    for (const key of [
      "tagsCache",
      "contentSource",
      "sceneId",
      "sourceChatMessageId",
    ] as const) {
      if (Object.hasOwn(payload, key)) {
        requireNullableStringField(payload, key, command);
      }
    }
    if (
      payload.contentSource !== undefined &&
      payload.contentSource !== null &&
      payload.contentSource !== "human" &&
      payload.contentSource !== "ai"
    ) {
      throw new Error(
        `invalid args \`contentSource\` for command \`${command}\`: expected human, ai, or null`,
      );
    }
    return payload;
  }

  const baseVersion = requireSafeInteger(payload, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  if (command === "snippet_update") {
    const fields = ["title", "content", "tagsCache", "sceneId"] as const;
    if (!fields.some((key) => Object.hasOwn(payload, key))) {
      throw new Error(
        `invalid args for command \`${command}\`: expected at least one changed field`,
      );
    }
    for (const key of fields) {
      if (Object.hasOwn(payload, key)) requireString(payload, key, command);
    }
    requireTimelapseDocStepCoverage(payload, command);
  }
  return payload;
}

function requireTimelapseDocStepCoverage(
  payload: CommandArgs,
  command:
    | "codex_update"
    | "snippet_update"
    | "save_scene_body_bundle"
    | "tree_node_patch",
): void {
  if (!Object.hasOwn(payload, "timelapseDocStepCoverage")) return;
  const contentPayload =
    command === "tree_node_patch"
      ? requireRecord(payload, "patch", command)
      : payload;
  const contentKey =
    command === "save_scene_body_bundle" ? "contentJson" : "content";
  if (!Object.hasOwn(contentPayload, contentKey)) {
    throw new Error(
      `invalid args \`timelapseDocStepCoverage\` for command \`${command}\`: coverage requires content`,
    );
  }
  requireString(contentPayload, contentKey, command);
  if (
    command === "save_scene_body_bundle" &&
    Object.hasOwn(payload, "timelapseSteps")
  ) {
    throw new Error(
      `invalid args \`timelapseDocStepCoverage\` for command \`${command}\`: coverage cannot be combined with timelapseSteps`,
    );
  }
  const proof = requireRecord(payload, "timelapseDocStepCoverage", command);
  const expectedKeys = new Set(["eventUid", "sessionId", "contentDigest"]);
  const proofKeys = Object.keys(proof);
  if (
    proofKeys.length !== expectedKeys.size ||
    proofKeys.some((key) => !expectedKeys.has(key))
  ) {
    throw new Error(
      `invalid args \`timelapseDocStepCoverage\` for command \`${command}\`: expected exactly eventUid, sessionId, and contentDigest`,
    );
  }
  for (const key of ["eventUid", "sessionId"] as const) {
    if (requireNonEmptyString(proof, key, command).trim().length === 0) {
      throw new Error(
        `invalid args \`timelapseDocStepCoverage.${key}\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  }
  const contentDigest = requireString(proof, "contentDigest", command);
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
    throw new Error(
      `invalid args \`timelapseDocStepCoverage.contentDigest\` for command \`${command}\`: expected a lowercase sha256 digest`,
    );
  }
}

function requireAuthorshipReplaceLanePayload(args: CommandArgs): CommandArgs {
  const command = "authorship_replace_lane";
  const payload = requireRecord(args, "payload", command);
  const lane = requireRecord(payload, "lane", command);
  const kind = requireString(lane, "kind", command);
  switch (kind) {
    case "node":
      requireNonEmptyString(lane, "nodeId", command);
      break;
    case "codex":
      requireNonEmptyString(lane, "codexEntryId", command);
      break;
    case "snippet":
      requireNonEmptyString(lane, "snippetId", command);
      break;
    case "detail":
      requireNonEmptyString(lane, "detailValueId", command);
      requireNonEmptyString(lane, "codexEntryId", command);
      break;
    case "phase":
      requireNonEmptyString(lane, "phaseId", command);
      requireNonEmptyString(lane, "codexEntryId", command);
      break;
    default:
      throw new Error(
        `invalid args \`lane.kind\` for command \`${command}\`: expected a supported authorship owner lane`,
      );
  }
  requireArray(payload, "spans", command).forEach((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `invalid args \`spans[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const span = value as CommandArgs;
    requireNonEmptyString(span, "id", command);
    const fromPos = requireSafeInteger(span, "fromPos", command);
    const toPos = requireSafeInteger(span, "toPos", command);
    if (fromPos < 0 || toPos < fromPos) {
      throw new Error(
        `invalid args \`spans[${index}]\` for command \`${command}\`: invalid position range`,
      );
    }
    const source = requireString(span, "source", command);
    if (source !== "human" && source !== "ai" && source !== "unknown") {
      throw new Error(
        `invalid args \`spans[${index}].source\` for command \`${command}\`: expected human, ai, or unknown`,
      );
    }
    for (const key of ["model", "timestamp", "chatMsgId", "traceId"]) {
      requireNullableStringField(span, key, command);
    }
  });
  return payload;
}

function requireEntityTagsSetPayload(args: CommandArgs): CommandArgs {
  const command = "entity_tags_set";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
  ]);
  const kind = requireString(payload, "entityKind", command);
  if (kind !== "codex" && kind !== "snippet") {
    throw new Error(
      `invalid args \`entityKind\` for command \`${command}\`: expected codex or snippet`,
    );
  }
  requireNonEmptyString(payload, "entityId", command);
  requireArray(payload, "tagIds", command).forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid args \`tagIds[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  const updatedAt = requireNullableStringField(payload, "updatedAt", command);
  if (kind === "codex" && !updatedAt) {
    throw new Error(
      `invalid args \`updatedAt\` for command \`${command}\`: expected a non-empty string for codex`,
    );
  }
  return payload;
}

const CODEX_RENAME_UNDO_KINDS = new Set([
  "scene-body",
  "node-title",
  "node-synopsis",
  "codex-summary",
  "codex-content",
  "codex-notes",
  "codex-detail",
  "codex-relation-label",
]);

function requireCodexRenameUpdatesPayload(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "updatedAt", command);
  requireArray(payload, "updates", command).forEach((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `invalid args \`updates[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const update = value as CommandArgs;
    const kind = requireString(update, "kind", command);
    if (!CODEX_RENAME_UNDO_KINDS.has(kind)) {
      throw new Error(
        `invalid args \`updates[${index}].kind\` for command \`${command}\`: expected a supported rename source`,
      );
    }
    requireNonEmptyString(update, "refId", command);
    requireString(update, "value", command);
    const detailDefinitionId = requireNullableStringField(
      update,
      "detailDefinitionId",
      command,
    );
    if (kind === "codex-detail" && !detailDefinitionId) {
      throw new Error(
        `invalid args \`updates[${index}].detailDefinitionId\` for command \`${command}\`: expected a non-empty string`,
      );
    }
    const baseVersion = requirePresent(update, "baseVersion", command);
    if (
      typeof baseVersion !== "number" ||
      !Number.isSafeInteger(baseVersion) ||
      baseVersion < 0
    ) {
      throw new Error(
        `invalid args \`updates[${index}].baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
    const charCount = requirePresent(update, "charCount", command);
    if (
      charCount !== null &&
      (typeof charCount !== "number" ||
        !Number.isSafeInteger(charCount) ||
        charCount < 0)
    ) {
      throw new Error(
        `invalid args \`updates[${index}].charCount\` for command \`${command}\`: expected a non-negative safe integer or null`,
      );
    }
    if (kind === "scene-body" && charCount === null) {
      throw new Error(
        `invalid args \`updates[${index}].charCount\` for command \`${command}\`: scene body requires a count`,
      );
    }
    requireNullableStringField(update, "placedBeatPreview", command);
  });
  return payload;
}

function requireCodexRenameUndoPayload(args: CommandArgs): CommandArgs {
  const command = "codex_rename_undo";
  const payload = requireCodexRenameUpdatesPayload(args, command);
  for (const key of [
    "requestId",
    "eventUid",
    "sessionId",
    "originalTransactionId",
    "undoJournalId",
  ]) {
    requireNonEmptyString(payload, key, command);
  }
  return payload;
}

function requireCodexRenameApplyPayload(args: CommandArgs): CommandArgs {
  const command = "codex_rename_apply";
  const payload = requireCodexRenameUpdatesPayload(args, command);
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "sessionId", command);
  requireNonEmptyString(payload, "entryId", command);
  requireNonEmptyString(payload, "eventSummary", command);
  requireNonEmptyString(payload, "eventUid", command);
  const timestamp = requirePresent(payload, "timestamp", command);
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
    throw new Error(
      `invalid args \`timestamp\` for command \`${command}\`: expected a safe integer`,
    );
  }
  const redo = requirePresent(payload, "redo", command);
  if (typeof redo !== "boolean") {
    throw new Error(
      `invalid args \`redo\` for command \`${command}\`: expected a boolean`,
    );
  }
  const originalTransactionId = requireNullableStringField(
    payload,
    "originalTransactionId",
    command,
  );
  const undoJournalId = requireNullableStringField(
    payload,
    "undoJournalId",
    command,
  );
  if (
    (redo && (!originalTransactionId || !undoJournalId)) ||
    (!redo && (originalTransactionId || undoJournalId))
  ) {
    throw new Error(
      `invalid redo lineage for command \`${command}\`: expected originalTransactionId and undoJournalId only for redo`,
    );
  }
  return payload;
}

function requireScanStagingProjectCreatePayload(
  args: CommandArgs,
): CommandArgs {
  const command = "scan_staging_project_create";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["id", "title", "createdAt"]) {
    requireNonEmptyString(payload, key, command);
  }
  const language = requireString(payload, "language", command);
  if (language !== "ja" && language !== "en") {
    throw new Error(
      `invalid args \`language\` for command \`${command}\`: expected ja or en`,
    );
  }
  return payload;
}

function requireScanStagingProjectPublishPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "scan_staging_project_publish";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "import-apply",
  ]);
  if (payload.origin !== "import") {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: Scan publication is import-only`,
    );
  }
  return payload;
}

function requireProjectCreatePayload(args: CommandArgs): CommandArgs {
  const command = "project_create";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
  ]);
  if (payload.origin === "undo" || payload.origin === "redo") {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: project creation is forward-only`,
    );
  }
  for (const key of ["title", "createdAt", "updatedAt"]) {
    requireNonEmptyString(payload, key, command);
  }
  for (const key of [
    "genre",
    "pov",
    "tense",
    "language",
    "styleGuide",
    "aiInstructions",
    "outline",
    "targetReaders",
  ]) {
    requireNullableStringField(payload, key, command);
  }
  return payload;
}

function requireProjectPatchPayload(args: CommandArgs): CommandArgs {
  const command = "project_patch";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
  ]);
  requireNonEmptyString(payload, "baseUpdatedAt", command);
  requireNonEmptyString(payload, "updatedAt", command);
  const patch = requireRecord(payload, "patch", command);
  const allowed = new Set([
    "title",
    "genre",
    "pov",
    "tense",
    "language",
    "styleGuide",
    "aiInstructions",
    "outline",
    "targetReaders",
    "aiPolicy",
    "phaseResolutionMode",
  ]);
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new Error(
      `invalid args \`patch\` for command \`${command}\`: expected non-empty Project metadata fields`,
    );
  }
  for (const key of keys) {
    requireNullableStringField(patch, key, command);
  }
  if (Object.hasOwn(patch, "title") && patch.title === null) {
    throw new Error(
      `invalid args \`patch.title\` for command \`${command}\`: title cannot be null`,
    );
  }
  return payload;
}

function requireProjectDeletePayload(args: CommandArgs): CommandArgs {
  const command = "project_delete";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
  ]);
  requireNonEmptyString(payload, "projectId", command);
  return payload;
}

function requireAiTreePlanApplyPayload(args: CommandArgs): CommandArgs {
  const command = "ai_tree_plan_apply";
  const rawPayload = requireRecord(args, "payload", command);
  const redo = requireBoolean(rawPayload, "redo", command);
  const payload = Object.hasOwn(rawPayload, "authorityRoute")
    ? requireCanonicalWriterIdentity(args, command, [
        redo ? "history-replay" : "interactive-agent-command",
      ])
    : rawPayload;
  const interactiveAgentTreePlan =
    !redo && payload.authorityRoute === "interactive-agent-command";
  for (const key of [
    "requestId",
    "projectId",
    "sessionId",
    "surface",
    "updatedAt",
  ]) {
    requireNonEmptyString(payload, key, command);
  }
  const kind = requireString(payload, "kind", command);
  if (kind !== "scaffold" && kind !== "reorganize") {
    throw new Error(
      `invalid args \`kind\` for command \`${command}\`: expected scaffold or reorganize`,
    );
  }
  requireNullableStringField(payload, "model", command);
  requireNullableStringField(payload, "traceId", command);
  const creates = requireArray(payload, "creates", command);
  creates.forEach((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `invalid args \`creates[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const create = value as CommandArgs;
    if (interactiveAgentTreePlan) {
      const tempId = requireNonEmptyString(create, "tempId", command);
      if (!tempId.startsWith("tmp:")) {
        throw new Error(
          `invalid args \`creates[${index}].tempId\` for command \`${command}\``,
        );
      }
    }
    for (const key of ["id", "nodeType", "title", "sortOrder"]) {
      requireNonEmptyString(create, key, command);
    }
    if (!["folder", "scene", "note"].includes(String(create.nodeType))) {
      throw new Error(
        `invalid args \`creates[${index}].nodeType\` for command \`${command}\``,
      );
    }
    requireNullableStringField(create, "parentId", command);
    requireNullableStringField(create, "synopsis", command);
  });
  const updates = requireArray(payload, "updates", command);
  updates.forEach((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `invalid args \`updates[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const update = value as CommandArgs;
    requireNonEmptyString(update, "id", command);
    const baseVersion = requirePresent(update, "baseVersion", command);
    if (
      typeof baseVersion !== "number" ||
      !Number.isSafeInteger(baseVersion) ||
      baseVersion < 0
    ) {
      throw new Error(
        `invalid args \`updates[${index}].baseVersion\` for command \`${command}\``,
      );
    }
    const placement = requirePresent(update, "placement", command);
    if (placement !== null) {
      if (typeof placement !== "object" || Array.isArray(placement)) {
        throw new Error(
          `invalid args \`updates[${index}].placement\` for command \`${command}\``,
        );
      }
      const placementRecord = placement as CommandArgs;
      requireNullableStringField(placementRecord, "parentId", command);
      requireNonEmptyString(placementRecord, "sortOrder", command);
    }
    const title = requirePresent(update, "title", command);
    if (title !== null && (typeof title !== "string" || title.length === 0)) {
      throw new Error(
        `invalid args \`updates[${index}].title\` for command \`${command}\``,
      );
    }
    if (placement === null && title === null) {
      throw new Error(
        `invalid args \`updates[${index}]\` for command \`${command}\`: empty update`,
      );
    }
  });
  if (creates.length === 0 && updates.length === 0) {
    throw new Error(`invalid args for command \`${command}\`: empty plan`);
  }
  if (interactiveAgentTreePlan) {
    const ops = requireArray(payload, "ops", command);
    if (ops.length === 0) {
      throw new Error(
        `invalid args \`ops\` for command \`${command}\`: empty plan`,
      );
    }
  }
  const originalTransactionId = requireNullableStringField(
    payload,
    "originalTransactionId",
    command,
  );
  const undoJournalId = requireNullableStringField(
    payload,
    "undoJournalId",
    command,
  );
  if (
    (redo && (!originalTransactionId || !undoJournalId)) ||
    (!redo && (originalTransactionId || undoJournalId))
  ) {
    throw new Error(`invalid redo lineage for command \`${command}\``);
  }
  return payload;
}

function requireAiTreePlanUndoPayload(args: CommandArgs): CommandArgs {
  const command = "ai_tree_plan_undo";
  const rawPayload = requireRecord(args, "payload", command);
  const payload = Object.hasOwn(rawPayload, "authorityRoute")
    ? requireCanonicalWriterIdentity(args, command, ["history-replay"])
    : rawPayload;
  for (const key of [
    "requestId",
    "projectId",
    "sessionId",
    "updatedAt",
    "originalTransactionId",
    "undoJournalId",
  ]) {
    requireNonEmptyString(payload, key, command);
  }
  requireArray(payload, "expectedVersions", command).forEach((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `invalid args \`expectedVersions[${index}]\` for command \`${command}\``,
      );
    }
    const expected = value as CommandArgs;
    requireNonEmptyString(expected, "id", command);
    const version = requirePresent(expected, "version", command);
    if (
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      throw new Error(
        `invalid args \`expectedVersions[${index}].version\` for command \`${command}\``,
      );
    }
  });
  return payload;
}

function requireTreeNodeCreatePayload(args: CommandArgs): CommandArgs {
  const command = "tree_node_create";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
    "import-apply",
    "history-replay",
    "restore-or-migration",
  ]);
  for (const key of ["id", "projectId", "nodeType", "title", "sortOrder"]) {
    requireNonEmptyString(payload, key, command);
  }
  const nodeType = payload.nodeType;
  if (nodeType !== "folder" && nodeType !== "scene" && nodeType !== "note") {
    throw new Error(
      `invalid args \`nodeType\` for command \`${command}\`: expected folder, scene, or note`,
    );
  }
  for (const key of [
    "parentId",
    "synopsis",
    "status",
    "sourceUri",
    "sourceMtime",
    "content",
  ]) {
    if (Object.hasOwn(payload, key))
      requireNullableStringField(payload, key, command);
  }
  return payload;
}

function requireTreeNodeDeletePayload(args: CommandArgs): CommandArgs {
  const command = "tree_node_delete";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
    "history-replay",
    "restore-or-migration",
  ]);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "nodeId", command);
  return payload;
}

function requireTreeNodePatchPayload(args: CommandArgs): CommandArgs {
  const command = "tree_node_patch";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
    "import-apply",
    "history-replay",
    "restore-or-migration",
  ]);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "nodeId", command);
  requireNonEmptyString(payload, "updatedAt", command);
  const patch = requireRecord(payload, "patch", command);
  requireTimelapseDocStepCoverage(payload, command);
  requireBoolean(payload, "bumpVersion", command);
  if (Object.hasOwn(payload, "baseVersion")) {
    const baseVersion = requireSafeInteger(payload, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  }
  if (Object.hasOwn(payload, "changeEvent")) {
    const event = requireRecord(payload, "changeEvent", command);
    requireNonEmptyString(event, "eventUid", command);
    requireNonEmptyString(event, "sessionId", command);
    if (
      event.eventUid !== payload.eventUid ||
      event.sessionId !== payload.sessionId
    ) {
      throw new Error(
        `invalid args \`changeEvent\` for command \`${command}\`: identity must match writer identity`,
      );
    }
    const timestamp = requireSafeInteger(event, "timestamp", command);
    if (timestamp < 0) {
      throw new Error(
        `invalid args \`changeEvent.timestamp\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
    if (
      !Object.hasOwn(payload, "baseVersion") ||
      payload.bumpVersion !== true
    ) {
      throw new Error(
        `invalid args \`changeEvent\` for command \`${command}\`: expected versioned OCC`,
      );
    }
    if (
      !Object.hasOwn(patch, "content") ||
      Object.keys(patch).some((key) => key !== "content" && key !== "charCount")
    ) {
      throw new Error(
        `invalid args \`changeEvent\` for command \`${command}\`: expected a content-only patch`,
      );
    }
  }
  const hasTrackedOverride = ["sourceDomain", "opType"].some((key) =>
    Object.hasOwn(payload, key),
  );
  if (hasTrackedOverride) {
    requireNonEmptyString(payload, "requestId", command);
    requireNonEmptyString(payload, "sessionId", command);
    if (
      payload.origin !== "restore" ||
      payload.sourceDomain !== "revision" ||
      payload.opType !== "content.restore"
    ) {
      throw new Error(
        `invalid tracked override for command \`${command}\`: expected revision content.restore with restore origin`,
      );
    }
    if (!Object.hasOwn(payload, "changeEvent")) {
      throw new Error(
        `invalid tracked override for command \`${command}\`: expected changeEvent`,
      );
    }
  }
  return payload;
}

function requireTemporalScenePatchPayload(args: CommandArgs): CommandArgs {
  const command = "temporal_scene_patch";
  const payload = requireCanonicalWriterIdentity(args, command, [
    "human-direct",
  ]);
  requireNonEmptyString(payload, "targetId", command);
  const baseVersion = requireSafeInteger(payload, "baseVersion", command);
  if (baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
  requirePresent(payload, "storyTimeOrder", command);
  requirePresent(payload, "storyTimeLabel", command);
  requirePresent(payload, "startTime", command);
  requirePresent(payload, "startMinute", command);
  requireString(payload, "startGranularity", command);
  requirePresent(payload, "endTime", command);
  requirePresent(payload, "endMinute", command);
  requireString(payload, "endGranularity", command);
  requireString(payload, "precision", command);
  return payload;
}

function requireMapWriteStringArray(
  payload: CommandArgs,
  key: string,
  command: string,
): unknown[] {
  const values = requireArray(payload, key, command);
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `invalid args \`${key}[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return values;
}

function requireMapWritePayload(args: CommandArgs): CommandArgs {
  const command = "map_write_bundle";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["requestId", "sessionId", "eventUid"]) {
    requireNonEmptyString(payload, key, command);
  }
  const kind = requireString(payload, "kind", command);
  requireNonEmptyString(payload, "projectId", command);
  if (!Object.hasOwn(payload, "origin")) payload.origin = "human";
  if (!Object.hasOwn(payload, "originalTransactionId")) {
    payload.originalTransactionId = null;
  }
  if (!Object.hasOwn(payload, "undoJournalId")) payload.undoJournalId = null;
  const origin = requireString(payload, "origin", command);
  if (origin !== "human" && origin !== "undo" && origin !== "redo") {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: expected human, undo, or redo`,
    );
  }
  const originalTransactionId = requireNullableStringField(
    payload,
    "originalTransactionId",
    command,
  );
  const undoJournalId = requireNullableStringField(
    payload,
    "undoJournalId",
    command,
  );
  const replay = origin === "undo" || origin === "redo";
  if (
    replay !==
      (Boolean(originalTransactionId?.length) &&
        Boolean(undoJournalId?.length)) ||
    (!replay && (originalTransactionId !== null || undoJournalId !== null))
  ) {
    throw new Error(
      `invalid canonical lineage for command \`${command}\`: undo/redo requires originalTransactionId and undoJournalId`,
    );
  }

  switch (kind) {
    case "create-board":
      requireSnapshotScalarRow(
        requirePresent(payload, "board", command),
        "board",
        command,
      );
      for (const key of ["stickies", "positions", "edges", "frames"]) {
        requireSnapshotRows(payload, key, command);
      }
      break;
    case "create-ai-branch":
    case "restore-ai-branch":
      requireSnapshotScalarRow(
        requirePresent(payload, "branch", command),
        "branch",
        command,
      );
      requireSnapshotScalarRow(
        requirePresent(payload, "branchPosition", command),
        "branchPosition",
        command,
      );
      for (const key of ["stickies", "positions", "edges", "spans"]) {
        requireSnapshotRows(payload, key, command);
      }
      break;
    case "promote-sticky": {
      for (const key of [
        "boardId",
        "targetType",
        "newEntityId",
        "title",
        "body",
        "positionId",
        "stickyId",
        "createdAt",
        "updatedAt",
      ]) {
        requireNonEmptyString(payload, key, command);
      }
      const targetType = requireString(payload, "targetType", command);
      if (
        targetType !== "scene" &&
        targetType !== "note" &&
        targetType !== "snippet" &&
        targetType !== "codex"
      ) {
        throw new Error(
          `invalid args \`targetType\` for command \`${command}\`: expected scene, note, snippet, or codex`,
        );
      }
      requireNullableStringField(payload, "parentId", command);
      const sortOrder = requireNullableStringField(
        payload,
        "sortOrder",
        command,
      );
      const codexType = requireNullableStringField(
        payload,
        "codexType",
        command,
      );
      if ((targetType === "scene" || targetType === "note") && !sortOrder) {
        throw new Error(
          `invalid args \`sortOrder\` for command \`${command}\`: tree target requires a sort order`,
        );
      }
      if (targetType === "codex" && !codexType) {
        throw new Error(
          `invalid args \`codexType\` for command \`${command}\`: codex target requires a type`,
        );
      }
      break;
    }
    case "erase-ai-branch":
      requireNonEmptyString(payload, "branchId", command);
      for (const key of ["spanIds", "stickyPositionIds", "stickyIds"]) {
        requireMapWriteStringArray(payload, key, command);
      }
      break;
    case "extract-frame-to-codex":
      for (const key of [
        "boardId",
        "codexId",
        "codexType",
        "title",
        "content",
        "frameId",
        "createdAt",
        "updatedAt",
      ]) {
        requireNonEmptyString(payload, key, command);
      }
      requireMapWriteStringArray(payload, "stickyIds", command);
      requireSnapshotRows(payload, "positions", command);
      if (requireArray(payload, "positions", command).length !== 1) {
        throw new Error(
          `invalid args \`positions\` for command \`${command}\`: expected exactly one Codex position`,
        );
      }
      break;
    case "promote-user-edge-to-codex-relation":
      for (const key of [
        "boardId",
        "edgeId",
        "relationId",
        "fromCodexId",
        "toCodexId",
        "relationType",
        "label",
        "createdAt",
        "updatedAt",
      ]) {
        requireNonEmptyString(payload, key, command);
      }
      if (typeof payload.reuseExistingRelation !== "boolean") {
        throw new Error(
          `invalid args \`reuseExistingRelation\` for command \`${command}\`: expected a boolean`,
        );
      }
      break;
    default:
      throw new Error(
        `invalid args \`kind\` for command \`${command}\`: expected a supported map aggregate write`,
      );
  }
  return payload;
}

const PROJECT_SNAPSHOT_RESTORE_SCOPES = new Set([
  "body",
  "codex",
  "snippet",
  "map",
  "foreshadow",
  "labels",
  "lint",
]);

const PROJECT_SNAPSHOT_RESTORE_TABLES = new Set([
  "codex_types",
  "codex_entries",
  "codex_tags",
  "codex_detail_definitions",
  "codex_detail_semantic_bindings",
  "codex_entry_tags",
  "codex_detail_values",
  "codex_entry_phases",
  "codex_phase_detail_overrides",
  "codex_quick_pins",
  "codex_dismissed_relations",
  "codex_relations",
  "tree_nodes",
  "authorship_spans",
  "generation_logs",
  "post_effect_annotations",
  "post_effect_annotation_relations",
  "scene_codex_pins",
  "scene_codex_mentions",
  "scene_beat_pov_cache",
  "plot_threads",
  "plot_thread_scene_links",
  "plot_thread_branches",
  "events",
  "scene_events",
  "event_participants",
  "event_relations",
  "project_calendar",
  "snippets",
  "snippet_entry_tags",
  "labels",
  "tree_node_labels",
  "foreshadows",
  "foreshadow_setups",
  "foreshadow_payoffs",
  "foreshadow_setup_payoff_links",
  "foreshadow_codex_links",
  "map_boards",
  "map_ai_branches",
  "map_stickies",
  "editor_stickies",
  "map_frames",
  "map_node_positions",
  "map_edges",
  "lint_term_dictionary",
  "lint_ignored_diagnostics",
]);

function requireProjectSnapshotScopes(
  args: CommandArgs,
  key: string,
  command: string,
): unknown[] {
  const scopes = requireArray(args, key, command);
  scopes.forEach((scope, index) => {
    if (
      typeof scope !== "string" ||
      !PROJECT_SNAPSHOT_RESTORE_SCOPES.has(scope)
    ) {
      throw new Error(
        `invalid args \`${key}[${index}]\` for command \`${command}\`: expected a project snapshot restore scope`,
      );
    }
  });
  return scopes;
}

function requireSnapshotScalarRow(
  value: unknown,
  key: string,
  command: string,
): CommandArgs {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected an object`,
    );
  }
  const row = value as CommandArgs;
  if (Object.keys(row).length === 0) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected at least one SQLite scalar field`,
    );
  }
  for (const [column, field] of Object.entries(row)) {
    if (
      field !== null &&
      typeof field !== "string" &&
      (typeof field !== "number" || !Number.isFinite(field))
    ) {
      throw new Error(
        `invalid args \`${key}.${column}\` for command \`${command}\`: expected a SQLite scalar`,
      );
    }
  }
  return row;
}

function requireSnapshotRows(
  payload: CommandArgs,
  key: string,
  command: string,
): unknown[] {
  const rows = requireArray(payload, key, command);
  rows.forEach((row, index) => {
    requireSnapshotScalarRow(row, `${key}[${index}]`, command);
  });
  return rows;
}

function requireProjectSnapshotCreatePayload(args: CommandArgs): CommandArgs {
  const command = "project_snapshot_create";
  const payload = requireRecord(args, "payload", command);
  for (const key of ["projectId", "snapshotId", "name", "createdAt"]) {
    requireNonEmptyString(payload, key, command);
  }
  const description = requirePresent(payload, "description", command);
  if (description !== null && typeof description !== "string") {
    throw new Error(
      `invalid args \`description\` for command \`${command}\`: expected a string or null`,
    );
  }
  for (const key of ["treeRows", "codexRows", "snippetRows"]) {
    requireSnapshotRows(payload, key, command);
  }
  requireArray(payload, "versionIds", command).forEach((versionId, index) => {
    if (typeof versionId !== "string" || versionId.length === 0) {
      throw new Error(
        `invalid args \`versionIds[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return payload;
}

function requireProjectSnapshotApplyPayload(args: CommandArgs): CommandArgs {
  const command = "project_snapshot_apply_restore";
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "sessionId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "snapshotId", command);
  requireProjectSnapshotScopes(payload, "scopes", command);
  const inserts = requireArray(payload, "inserts", command);
  inserts.forEach((value, index) => {
    const insert = requirePlotSnapshotRecord(
      value,
      `inserts[${index}]`,
      command,
    );
    const table = requireString(insert, "table", command);
    if (!PROJECT_SNAPSHOT_RESTORE_TABLES.has(table)) {
      throw new Error(
        `invalid args \`inserts[${index}].table\` for command \`${command}\`: expected an allowlisted snapshot table`,
      );
    }
    const mode = requireString(insert, "mode", command);
    if (
      (mode !== "insert" && mode !== "replace") ||
      (mode === "replace" && table !== "codex_types")
    ) {
      throw new Error(
        `invalid args \`inserts[${index}].mode\` for command \`${command}\`: expected insert, or replace for codex_types`,
      );
    }
    requireSnapshotScalarRow(
      requirePresent(insert, "row", command),
      `inserts[${index}].row`,
      command,
    );
  });
  return payload;
}

function requireRevisionSceneRestorePayload(args: CommandArgs): CommandArgs {
  const command = "revision_scene_restore";
  const payload = requireRecord(args, "payload", command);
  const allowedKeys = new Set([
    "requestId",
    "sessionId",
    "projectId",
    "entityType",
    "entityId",
    "revisionId",
    "content",
    "currentContent",
    "expectedVersion",
    "charCount",
    "placedBeatPreview",
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  for (const key of [
    "requestId",
    "sessionId",
    "projectId",
    "entityId",
    "revisionId",
  ]) {
    requireNonEmptyString(payload, key, command);
  }
  if (requireString(payload, "entityType", command) !== "scene") {
    throw new Error(
      `invalid args \`entityType\` for command \`${command}\`: only scene is supported`,
    );
  }
  requireString(payload, "content", command);
  requireString(payload, "currentContent", command);
  for (const key of ["expectedVersion", "charCount"]) {
    const value = requireSafeInteger(payload, key, command);
    if (value < 0) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  }
  requireNullableStringField(payload, "placedBeatPreview", command);
  return payload;
}

function requirePlotSnapshotRecord(
  value: unknown,
  key: string,
  command: string,
): CommandArgs {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected an object`,
    );
  }
  return value as CommandArgs;
}

function requirePlotSnapshotVersion(
  row: CommandArgs,
  key: string,
  command: string,
): void {
  const version = requireSafeInteger(row, "version", command);
  if (version < 0) {
    throw new Error(
      `invalid args \`${key}.version\` for command \`${command}\`: expected a non-negative safe integer`,
    );
  }
}

function validateOptionalPlotSnapshotId(
  row: CommandArgs,
  key: string,
  command: string,
): void {
  const value = nullableString(row, key, command);
  if (value === "") {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a non-empty string or null`,
    );
  }
}

function requirePlotThreadRestoreSnapshotPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "plot_thread_restore_snapshot";
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  const requestId = requireNonEmptyString(payload, "requestId", command);
  const projectId = requireNonEmptyString(payload, "projectId", command);
  void requestId;

  if (!Object.hasOwn(payload, "thread")) {
    throw new Error(
      `invalid args \`thread\` for command \`${command}\`: missing required key thread`,
    );
  }
  const threadValue = payload.thread;
  if (threadValue !== null) {
    const thread = requirePlotSnapshotRecord(threadValue, "thread", command);
    requirePlotSnapshotVersion(thread, "thread", command);
    for (const key of [
      "id",
      "projectId",
      "name",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ] as const) {
      requireNonEmptyString(thread, key, command);
    }
    nullableString(thread, "color", command);
    nullableString(thread, "description", command);
    validateOptionalPlotSnapshotId(thread, "startNodeId", command);
    validateOptionalPlotSnapshotId(thread, "endNodeId", command);
    if (thread.projectId !== projectId) {
      throw new Error(
        `invalid args \`thread.projectId\` for command \`${command}\`: expected snapshot projectId`,
      );
    }
  }

  const links = requireArray(payload, "links", command).map((value, index) => {
    const link = requirePlotSnapshotRecord(value, `links[${index}]`, command);
    requirePlotSnapshotVersion(link, `links[${index}]`, command);
    for (const key of [
      "id",
      "threadId",
      "nodeId",
      "phaseType",
      "createdAt",
      "updatedAt",
    ] as const) {
      requireNonEmptyString(link, key, command);
    }
    nullableString(link, "note", command);
    nullableString(link, "sortOrder", command);
    if (
      !["introduce", "develop", "turn", "climax", "resolve"].includes(
        String(link.phaseType),
      )
    ) {
      throw new Error(
        `invalid args \`phaseType\` for command \`${command}\`: invalid plot phase`,
      );
    }
    return link;
  });
  const branches = requireArray(payload, "branches", command).map(
    (value, index) => {
      const branch = requirePlotSnapshotRecord(
        value,
        `branches[${index}]`,
        command,
      );
      requirePlotSnapshotVersion(branch, `branches[${index}]`, command);
      for (const key of [
        "id",
        "projectId",
        "fromThreadId",
        "toThreadId",
        "atNodeId",
        "kind",
        "createdAt",
        "updatedAt",
      ] as const) {
        requireNonEmptyString(branch, key, command);
      }
      if (branch.projectId !== projectId) {
        throw new Error(
          `invalid args \`branch.projectId\` for command \`${command}\`: expected snapshot projectId`,
        );
      }
      if (branch.fromThreadId === branch.toThreadId) {
        throw new Error(
          `invalid args for command \`${command}\`: branch cannot self-reference`,
        );
      }
      if (branch.kind !== "branch" && branch.kind !== "merge") {
        throw new Error(
          `invalid args \`kind\` for command \`${command}\`: expected branch or merge`,
        );
      }
      return branch;
    },
  );
  if (threadValue === null && links.length === 0 && branches.length === 0) {
    throw new Error(
      `invalid args for command \`${command}\`: snapshot must contain at least one row`,
    );
  }
  if (new Set(links.map((row) => row.id)).size !== links.length) {
    throw new Error(
      `invalid args for command \`${command}\`: duplicate link ids`,
    );
  }
  if (new Set(branches.map((row) => row.id)).size !== branches.length) {
    throw new Error(
      `invalid args for command \`${command}\`: duplicate branch ids`,
    );
  }
  return payload;
}

function requirePlotThreadDeleteSnapshotPayload(
  args: CommandArgs,
): CommandArgs {
  const command = "plot_thread_delete_snapshot";
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  requireNonEmptyString(payload, "requestId", command);
  const projectId = requireNonEmptyString(payload, "projectId", command);
  const hasThread = payload.thread !== undefined && payload.thread !== null;
  const hasLink = payload.link !== undefined && payload.link !== null;
  if (hasThread === hasLink) {
    throw new Error(
      `invalid args for command \`${command}\`: expected exactly one of thread or link`,
    );
  }

  if (hasThread) {
    const thread = requirePlotSnapshotRecord(payload.thread, "thread", command);
    requirePlotSnapshotVersion(thread, "thread", command);
    for (const key of [
      "id",
      "projectId",
      "name",
      "sortOrder",
      "createdAt",
      "updatedAt",
    ] as const) {
      requireNonEmptyString(thread, key, command);
    }
    nullableString(thread, "color", command);
    nullableString(thread, "description", command);
    validateOptionalPlotSnapshotId(thread, "startNodeId", command);
    validateOptionalPlotSnapshotId(thread, "endNodeId", command);
    if (thread.projectId !== projectId) {
      throw new Error(
        `invalid args \`thread.projectId\` for command \`${command}\`: expected snapshot projectId`,
      );
    }
  }

  const validateLink = (value: unknown, key: string): CommandArgs => {
    const link = requirePlotSnapshotRecord(value, key, command);
    requirePlotSnapshotVersion(link, key, command);
    for (const field of [
      "id",
      "threadId",
      "nodeId",
      "phaseType",
      "createdAt",
      "updatedAt",
    ] as const) {
      requireNonEmptyString(link, field, command);
    }
    nullableString(link, "note", command);
    nullableString(link, "sortOrder", command);
    if (
      !["introduce", "develop", "turn", "climax", "resolve"].includes(
        String(link.phaseType),
      )
    ) {
      throw new Error(
        `invalid args \`phaseType\` for command \`${command}\`: invalid plot phase`,
      );
    }
    return link;
  };
  if (hasLink) validateLink(payload.link, "link");
  const links = Object.hasOwn(payload, "links")
    ? requireArray(payload, "links", command).map((value, index) =>
        validateLink(value, `links[${index}]`),
      )
    : [];
  if (hasLink && links.length > 0) {
    throw new Error(
      `invalid args \`links\` for command \`${command}\`: marker snapshot cannot contain aggregate links`,
    );
  }
  const branches = requireArray(payload, "branches", command).map(
    (value, index) => {
      const branch = requirePlotSnapshotRecord(
        value,
        `branches[${index}]`,
        command,
      );
      requirePlotSnapshotVersion(branch, `branches[${index}]`, command);
      for (const key of [
        "id",
        "projectId",
        "fromThreadId",
        "toThreadId",
        "atNodeId",
        "kind",
        "createdAt",
        "updatedAt",
      ] as const) {
        requireNonEmptyString(branch, key, command);
      }
      if (branch.projectId !== projectId) {
        throw new Error(
          `invalid args \`branch.projectId\` for command \`${command}\`: expected snapshot projectId`,
        );
      }
      if (branch.fromThreadId === branch.toThreadId) {
        throw new Error(
          `invalid args for command \`${command}\`: branch cannot self-reference`,
        );
      }
      if (branch.kind !== "branch" && branch.kind !== "merge") {
        throw new Error(
          `invalid args \`kind\` for command \`${command}\`: expected branch or merge`,
        );
      }
      return branch;
    },
  );
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) {
    throw new Error(
      `invalid args \`branches\` for command \`${command}\`: duplicate ids`,
    );
  }
  if (new Set(links.map((link) => link.id)).size !== links.length) {
    throw new Error(
      `invalid args \`links\` for command \`${command}\`: duplicate ids`,
    );
  }
  return payload;
}

function requirePlotMoveLinkSnapshot(
  value: unknown,
  key: string,
  command: string,
): CommandArgs {
  const link = requirePlotSnapshotRecord(value, key, command);
  requirePlotSnapshotVersion(link, key, command);
  for (const field of [
    "id",
    "threadId",
    "nodeId",
    "phaseType",
    "createdAt",
    "updatedAt",
  ] as const) {
    requireNonEmptyString(link, field, command);
  }
  nullableString(link, "note", command);
  nullableString(link, "sortOrder", command);
  if (
    !["introduce", "develop", "turn", "climax", "resolve"].includes(
      String(link.phaseType),
    )
  ) {
    throw new Error(
      `invalid args \`${key}.phaseType\` for command \`${command}\`: invalid plot phase`,
    );
  }
  return link;
}

function requirePlotMoveBranchSnapshot(
  value: unknown,
  key: string,
  command: string,
  projectId: string,
): CommandArgs {
  const branch = requirePlotSnapshotRecord(value, key, command);
  requirePlotSnapshotVersion(branch, key, command);
  for (const field of [
    "id",
    "projectId",
    "fromThreadId",
    "toThreadId",
    "atNodeId",
    "kind",
    "createdAt",
    "updatedAt",
  ] as const) {
    requireNonEmptyString(branch, field, command);
  }
  if (branch.projectId !== projectId) {
    throw new Error(
      `invalid args \`${key}.projectId\` for command \`${command}\`: expected bundle projectId`,
    );
  }
  if (branch.fromThreadId === branch.toThreadId) {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: branch cannot self-reference`,
    );
  }
  if (branch.kind !== "branch" && branch.kind !== "merge") {
    throw new Error(
      `invalid args \`${key}.kind\` for command \`${command}\`: expected branch or merge`,
    );
  }
  return branch;
}

function requirePlotThreadMoveMarkerBundlePayload(
  args: CommandArgs,
): CommandArgs {
  const command = "plot_thread_move_marker_bundle";
  const payload = requireRecord(args, "payload", command);
  requirePlotMutationIdentity(payload, command);
  requireNonEmptyString(payload, "requestId", command);
  const projectId = requireNonEmptyString(payload, "projectId", command);
  const markerBefore = requirePlotMoveLinkSnapshot(
    payload.markerBefore,
    "markerBefore",
    command,
  );
  const markerAfter = requirePlotMoveLinkSnapshot(
    payload.markerAfter,
    "markerAfter",
    command,
  );
  if (markerBefore.id !== markerAfter.id) {
    throw new Error(
      `invalid args for command \`${command}\`: marker identity cannot change`,
    );
  }

  const ids = new Set<string>();
  requireArray(payload, "branchTransitions", command).forEach(
    (value, index) => {
      const key = `branchTransitions[${index}]`;
      const transition = requirePlotSnapshotRecord(value, key, command);
      if (
        !Object.hasOwn(transition, "before") ||
        !Object.hasOwn(transition, "after")
      ) {
        throw new Error(
          `invalid args \`${key}\` for command \`${command}\`: before and after are required`,
        );
      }
      const before =
        transition.before === null
          ? null
          : requirePlotMoveBranchSnapshot(
              transition.before,
              `${key}.before`,
              command,
              projectId,
            );
      const after =
        transition.after === null
          ? null
          : requirePlotMoveBranchSnapshot(
              transition.after,
              `${key}.after`,
              command,
              projectId,
            );
      if (before === null && after === null) {
        throw new Error(
          `invalid args \`${key}\` for command \`${command}\`: before or after is required`,
        );
      }
      if (before !== null && after !== null && before.id !== after.id) {
        throw new Error(
          `invalid args \`${key}\` for command \`${command}\`: branch identity cannot change`,
        );
      }
      const id = String(before?.id ?? after?.id);
      if (ids.has(id)) {
        throw new Error(
          `invalid args \`branchTransitions\` for command \`${command}\`: duplicate ids`,
        );
      }
      ids.add(id);
    },
  );
  return payload;
}

/** Tauri の i64 引数の写像（非 number は deserialize 失敗と同等に扱う）。 */
function requireNumber(args: CommandArgs, key: string, cmd: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a number`,
    );
  }
  return value;
}

function requireBoolean(args: CommandArgs, key: string, cmd: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a boolean`,
    );
  }
  return value;
}

function requireArray(args: CommandArgs, key: string, cmd: string): unknown[] {
  const value = requirePresent(args, key, cmd);
  if (!Array.isArray(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected an array`,
    );
  }
  return value;
}

/**
 * `timelapse-internal/doc.step.coverage` is a Native-owned proof row. The
 * renderer-facing batch command must never be an authority for that row: a
 * forged proof can otherwise make the body writer skip its full snapshot.
 * Keep the ordinary batch shape deliberately compatible and only reject the
 * reserved pair here; the Native/Tauri implementations repeat this guard.
 */
function requirePublicTimelapseAppendEvents(
  args: CommandArgs,
  command: string,
): unknown[] {
  const events = requireArray(args, "events", command);
  for (const [index, event] of events.entries()) {
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      continue;
    }
    const row = event as CommandArgs;
    if (
      row.domain === "timelapse-internal" &&
      row.opType === "doc.step.coverage"
    ) {
      throw new Error(
        `TIMELAPSE_COVERAGE_RESERVED: invalid args \`events[${index}]\` for command \`${command}\`: Native-owned timelapse coverage is not accepted by the public append batch`,
      );
    }
  }
  return events;
}

function requireSemanticRerankerShadowRequest(args: CommandArgs): CommandArgs {
  const command = "semantic_reranker_shadow_score";
  const allowedRequestKeys = new Set([
    "requestId",
    "expectedWorkspacePath",
    "projectId",
    "auditPathId",
    "language",
    "userMessage",
    "sceneTail",
    "candidates",
  ]);
  for (const key of Object.keys(args)) {
    if (!allowedRequestKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }

  const requestId = requireNonEmptyString(args, "requestId", command);
  if (requestId.length > 128) {
    throw new Error(
      `invalid args \`requestId\` for command \`${command}\`: too long`,
    );
  }
  const expectedWorkspacePath = requireNonEmptyString(
    args,
    "expectedWorkspacePath",
    command,
  );
  if (expectedWorkspacePath.length > 16_384) {
    throw new Error(
      `invalid args \`expectedWorkspacePath\` for command \`${command}\`: too long`,
    );
  }
  const projectId = requireNonEmptyString(args, "projectId", command);
  if (projectId.length > 512) {
    throw new Error(
      `invalid args \`projectId\` for command \`${command}\`: too long`,
    );
  }
  const auditPathId = requireString(args, "auditPathId", command);
  if (
    auditPathId !== "semantic_reranker" &&
    auditPathId !== "semantic_reranker_shadow"
  ) {
    throw new Error(
      `invalid args \`auditPathId\` for command \`${command}\`: unsupported path`,
    );
  }
  const language = requireString(args, "language", command);
  if (language !== "ja" && language !== "en") {
    throw new Error(
      `invalid args \`language\` for command \`${command}\`: expected ja or en`,
    );
  }
  const userMessage = requireString(args, "userMessage", command);
  const sceneTail = requireString(args, "sceneTail", command);
  if (userMessage.trim().length === 0 && sceneTail.trim().length === 0) {
    throw new Error(
      `invalid args \`userMessage\` for command \`${command}\`: query must not be empty`,
    );
  }
  if (userMessage.length > 100_000 || sceneTail.length > 10_000) {
    throw new Error(
      `invalid args for command \`${command}\`: query input is too large`,
    );
  }

  const candidates = requireArray(args, "candidates", command);
  if (candidates.length < 1 || candidates.length > 30) {
    throw new Error(
      `invalid args \`candidates\` for command \`${command}\`: expected 1..30 items`,
    );
  }
  const candidateIds = new Set<string>();
  for (const [index, value] of candidates.entries()) {
    const candidate = requireSceneBundleRecord(
      value,
      `candidates[${index}]`,
      command,
    );
    for (const key of Object.keys(candidate)) {
      if (key !== "candidateId" && key !== "text") {
        throw new Error(
          `invalid args \`candidates[${index}].${key}\` for command \`${command}\`: unknown field`,
        );
      }
    }
    const candidateId = requireNonEmptyString(
      candidate,
      "candidateId",
      command,
    );
    const text = requireNonEmptyString(candidate, "text", command);
    if (
      candidateId.length > 512 ||
      text.trim().length === 0 ||
      text.length > 100_000
    ) {
      throw new Error(
        `invalid args \`candidates[${index}]\` for command \`${command}\`: invalid candidate size`,
      );
    }
    if (candidateIds.has(candidateId)) {
      throw new Error(
        `invalid args \`candidates[${index}].candidateId\` for command \`${command}\`: duplicate`,
      );
    }
    candidateIds.add(candidateId);
  }
  return args;
}

function requireSceneBundleRecord(
  value: unknown,
  key: string,
  command: string,
): CommandArgs {
  return requireRecord({ [key]: value }, key, command);
}

function requireSceneBundleRange(
  value: CommandArgs,
  prefix: string,
  fromKey: string,
  toKey: string,
  command: string,
): void {
  const from = requireNumber(value, fromKey, command);
  const to = requireNumber(value, toKey, command);
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from
  ) {
    throw new Error(
      `invalid args \`${prefix}\` for command \`${command}\`: expected a non-negative ordered integer range`,
    );
  }
}

function requireNullableSceneBundleString(
  value: CommandArgs,
  key: string,
  command: string,
): void {
  const field = requirePresent(value, key, command);
  if (field !== null && typeof field !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${command}\`: expected a string or null`,
    );
  }
}

function requireSceneBodyBundlePayload(args: CommandArgs): CommandArgs {
  const command = "save_scene_body_bundle";
  const payload = requireRecord(args, "payload", command);
  for (const key of [
    "sceneId",
    "projectId",
    "requestId",
    "sessionId",
    "eventUid",
  ] as const) {
    if (requireString(payload, key, command).length === 0) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  }
  if (
    !new Set(["human", "ai-apply"]).has(
      requireString(payload, "origin", command),
    )
  ) {
    throw new Error(
      `invalid args \`origin\` for command \`${command}\`: expected human or ai-apply`,
    );
  }
  if (payload.timelapseSteps !== undefined) {
    const steps = requireArray(payload, "timelapseSteps", command);
    if (steps.length === 0) {
      throw new Error(
        `invalid args \`timelapseSteps\` for command \`${command}\`: expected a non-empty array`,
      );
    }
    steps.forEach((step, index) => {
      requireSceneBundleRecord(step, `timelapseSteps[${index}]`, command);
    });
  }
  requireBoolean(payload, "includeSidecars", command);
  requireNonEmptyString(payload, "updatedAt", command);
  if (payload.baseVersion !== undefined && payload.baseVersion !== null) {
    const baseVersion = requireNumber(payload, "baseVersion", command);
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
      throw new Error(
        `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  } else if (payload.baseVersion === null) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${command}\`: expected a non-negative safe integer when present`,
    );
  }
  requireString(payload, "contentJson", command);
  requireTimelapseDocStepCoverage(payload, command);
  requireString(payload, "unplacedBeatsDoc", command);
  for (const key of ["charCount", "docContentSize"] as const) {
    const value = requireNumber(payload, key, command);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
  }
  for (const key of ["placedBeatPreview", "unplacedBeatPreview"]) {
    requireNullableSceneBundleString(payload, key, command);
  }

  requireArray(payload, "authorshipSpans", command).forEach((item, index) => {
    const prefix = `authorshipSpans[${index}]`;
    const span = requireSceneBundleRecord(item, prefix, command);
    requireSceneBundleRange(span, prefix, "fromPos", "toPos", command);
    const source = requireString(span, "source", command);
    if (!["human", "ai", "unknown"].includes(source)) {
      throw new Error(
        `invalid args \`${prefix}.source\` for command \`${command}\`: invalid authorship source`,
      );
    }
    for (const key of ["model", "timestamp", "chatMsgId", "traceId"]) {
      requireNullableSceneBundleString(span, key, command);
    }
  });
  const foreshadowBaseVersions = requireRecord(
    payload,
    "foreshadowBaseVersions",
    command,
  );
  for (const [foreshadowId, version] of Object.entries(
    foreshadowBaseVersions,
  )) {
    if (
      foreshadowId.length === 0 ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      throw new Error(
        `invalid args \`foreshadowBaseVersions.${foreshadowId}\` for command \`${command}\``,
      );
    }
  }
  requireArray(payload, "foreshadowSetups", command).forEach((item, index) => {
    const prefix = `foreshadowSetups[${index}]`;
    const setup = requireSceneBundleRecord(item, prefix, command);
    requireString(setup, "id", command);
    requireString(setup, "foreshadowId", command);
    const baseVersion = requireSafeInteger(setup, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`${prefix}.baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
    requireSceneBundleRange(setup, prefix, "fromPos", "toPos", command);
  });
  requireArray(payload, "foreshadowPayoffs", command).forEach((item, index) => {
    const prefix = `foreshadowPayoffs[${index}]`;
    const payoff = requireSceneBundleRecord(item, prefix, command);
    requireString(payoff, "foreshadowId", command);
    const baseVersion = requireSafeInteger(payoff, "baseVersion", command);
    if (baseVersion < 0) {
      throw new Error(
        `invalid args \`${prefix}.baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
      );
    }
    requireSceneBundleRange(payoff, prefix, "fromPos", "toPos", command);
  });
  requireArray(payload, "annotationAnchors", command).forEach((item, index) => {
    const prefix = `annotationAnchors[${index}]`;
    const anchor = requireSceneBundleRecord(item, prefix, command);
    requireString(anchor, "id", command);
    requireString(anchor, "textSnapshot", command);
    requireSceneBundleRange(anchor, prefix, "rangeStart", "rangeEnd", command);
  });
  requireArray(payload, "beatMentions", command).forEach((item, index) => {
    const prefix = `beatMentions[${index}]`;
    const mention = requireSceneBundleRecord(item, prefix, command);
    requireString(mention, "beatId", command);
    requireString(mention, "codexId", command);
    const role = requireString(mention, "role", command);
    if (!["actor", "target", "mentioned"].includes(role)) {
      throw new Error(
        `invalid args \`${prefix}.role\` for command \`${command}\`: invalid mention role`,
      );
    }
  });
  requireArray(payload, "beatPovOverrides", command).forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(
        `invalid args \`beatPovOverrides[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return payload;
}

function requireRuntimePerformanceSeedArgs(args: CommandArgs): {
  ownerToken: string;
  payload: CommandArgs;
} {
  const command = "runtime_performance_seed";
  const ownerToken = requireNonEmptyString(args, "ownerToken", command);
  if (ownerToken.length > 200) {
    throw new Error(
      `invalid args \`ownerToken\` for command \`${command}\`: input limit exceeded`,
    );
  }
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "fixtureId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireRecord(payload, "mapBoard", command);
  requireRecord(payload, "projectSetting", command);
  const arrays = [
    ["treeNodes", 10_500],
    ["mapNodePositions", 2_200],
    ["mapEdges", 2_200],
    ["plotThreads", 200],
    ["plotThreadSceneLinks", 6_000],
    ["events", 5_500],
    ["eventRelations", 1_100],
    ["chatMessages", 5_500],
  ] as const;
  let totalRows = 2;
  for (const [key, limit] of arrays) {
    const rows = requireArray(payload, key, command);
    if (rows.length > limit || (key === "treeNodes" && rows.length === 0)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: input limit exceeded`,
      );
    }
    totalRows += rows.length;
  }
  const chatSession = requirePresent(payload, "chatSession", command);
  if (
    chatSession !== null &&
    (typeof chatSession !== "object" || Array.isArray(chatSession))
  ) {
    throw new Error(
      `invalid args \`chatSession\` for command \`${command}\`: expected an object or null`,
    );
  }
  totalRows += Number(chatSession !== null);
  if (totalRows > 25_000) {
    throw new Error(
      `invalid args \`payload\` for command \`${command}\`: total input limit exceeded`,
    );
  }
  return { ownerToken, payload };
}

const RENDERER_CHRONICLE_AUTHORITY_ROUTES = [
  "human-direct",
  "import-apply",
  "history-replay",
  "restore-or-migration",
] as const;

/** Agent and renderer Chronicle writers carry project, session, and retry identity. */
function requireAgentChroniclePayload(
  args: CommandArgs,
  cmd: string,
  allowedRoutes: readonly string[] = ["interactive-agent-command"],
): CommandArgs {
  const rawPayload = requireRecord(args, "payload", cmd);
  const payload = Object.hasOwn(rawPayload, "authorityRoute")
    ? requireCanonicalWriterIdentity(args, cmd, allowedRoutes)
    : rawPayload;
  requireNonEmptyString(payload, "requestId", cmd);
  requireNonEmptyString(payload, "projectId", cmd);
  requireNonEmptyString(payload, "sessionId", cmd);
  return payload;
}

/** Event aggregate mutations also carry the loaded OCC token. */
function requireEventMutationPayload(
  args: CommandArgs,
  cmd: string,
  allowedRoutes: readonly string[] = ["interactive-agent-command"],
): CommandArgs {
  const payload = requireAgentChroniclePayload(args, cmd, allowedRoutes);
  const baseVersion = requireNumber(payload, "baseVersion", cmd);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    throw new Error(
      `invalid args \`baseVersion\` for command \`${cmd}\`: expected a non-negative safe integer`,
    );
  }
  return payload;
}

function requireNarrativeCommitReplayPayload(
  args: CommandArgs,
  cmd: string,
): CommandArgs {
  const payload = requireRecord(args, "payload", cmd);
  requireNonEmptyString(payload, "projectId", cmd);
  requireNonEmptyString(payload, "sessionId", cmd);
  requireNonEmptyString(payload, "commitId", cmd);
  requireNonEmptyString(payload, "requestId", cmd);
  return payload;
}

const MAX_SCENE_EVENT_LINK_BATCH_SIZE = 10_000;

function requireSceneEventLinkBatchPayload(
  args: CommandArgs,
  command = "agent_scene_event_link_batch",
  allowedRoutes: readonly string[] = ["interactive-agent-command"],
): CommandArgs {
  const rawPayload = requireRecord(args, "payload", command);
  const payload = Object.hasOwn(rawPayload, "authorityRoute")
    ? requireCanonicalWriterIdentity(args, command, allowedRoutes)
    : rawPayload;
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "sessionId", command);
  requireNonEmptyString(payload, "eventId", command);
  if (Object.hasOwn(payload, "surface")) {
    requireNonEmptyString(payload, "surface", command);
  }
  const sceneIds = requireArray(payload, "sceneIds", command);
  if (
    sceneIds.length === 0 ||
    sceneIds.length > MAX_SCENE_EVENT_LINK_BATCH_SIZE
  ) {
    throw new Error(
      `invalid args \`sceneIds\` for command \`${command}\`: expected 1-${MAX_SCENE_EVENT_LINK_BATCH_SIZE} scene ids`,
    );
  }
  sceneIds.forEach((sceneId, index) => {
    if (typeof sceneId !== "string" || sceneId.length === 0) {
      throw new Error(
        `invalid args \`sceneIds[${index}]\` for command \`${command}\`: expected a non-empty string`,
      );
    }
  });
  return payload;
}

const MAX_CHRONICLE_BULK_PAYLOAD_BYTES = 8 * 1024 * 1024;

function requireChronicleBulkPayload(
  args: CommandArgs,
  command = "agent_chronicle_bulk_mutate",
  allowedRoutes: readonly string[] = ["interactive-agent-command"],
): CommandArgs {
  const rawPayload = requireRecord(args, "payload", command);
  const payload = Object.hasOwn(rawPayload, "authorityRoute")
    ? requireCanonicalWriterIdentity(args, command, allowedRoutes)
    : rawPayload;
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "sessionId", command);
  if (Object.hasOwn(payload, "surface")) {
    requireNonEmptyString(payload, "surface", command);
  }
  const operations = requireArray(payload, "operations", command);
  if (operations.length === 0) {
    throw new Error(
      `invalid args \`operations\` for command \`${command}\`: expected at least one operation`,
    );
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (payloadBytes > MAX_CHRONICLE_BULK_PAYLOAD_BYTES) {
    throw new Error(
      `invalid args \`payload\` for command \`${command}\`: encoded payload exceeds 8 MiB`,
    );
  }
  const targets = new Set<string>();
  const granularities = new Set([
    "none",
    "season",
    "year",
    "month",
    "day",
    "time",
  ]);
  const requireNullableSafeInteger = (
    operation: CommandArgs,
    field: string,
    key: string,
    minute: boolean,
  ): number | null => {
    const value = requirePresent(operation, field, command);
    if (
      value !== null &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        (minute && (value < 0 || value >= 1440)))
    ) {
      throw new Error(
        `invalid args \`${key}.${field}\` for command \`${command}\`: expected ${
          minute
            ? "null or an integer from 0 to 1439"
            : "null or a safe integer"
        }`,
      );
    }
    return value as number | null;
  };
  const requireAbsoluteDate = (operation: CommandArgs, key: string): void => {
    const startTime = requireNumber(operation, "startTime", command);
    if (!Number.isSafeInteger(startTime)) {
      throw new Error(
        `invalid args \`${key}.startTime\` for command \`${command}\`: expected a safe integer`,
      );
    }
    const startMinute = requireNullableSafeInteger(
      operation,
      "startMinute",
      key,
      true,
    );
    const endTime = requireNullableSafeInteger(
      operation,
      "endTime",
      key,
      false,
    );
    const endMinute = requireNullableSafeInteger(
      operation,
      "endMinute",
      key,
      true,
    );
    const startGranularity = requireString(
      operation,
      "startGranularity",
      command,
    );
    const endGranularity = requireString(operation, "endGranularity", command);
    if (
      !granularities.has(startGranularity) ||
      !granularities.has(endGranularity) ||
      startGranularity === "none" ||
      (startGranularity === "time"
        ? startMinute === null
        : startMinute !== null) ||
      (endGranularity === "none"
        ? endTime !== null || endMinute !== null
        : endTime === null ||
          (endGranularity === "time" ? endMinute === null : endMinute !== null))
    ) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected a canonical absolute Chronicle date`,
      );
    }
  };
  operations.forEach((value, index) => {
    const key = `operations[${index}]`;
    const operation = requireSceneBundleRecord(value, key, command);
    const kind = requireString(operation, "kind", command);
    let target: string;
    if (
      kind === "eventDelete" ||
      kind === "eventClearDate" ||
      kind === "eventSetLane" ||
      kind === "eventSetDate"
    ) {
      const eventId = requireNonEmptyString(operation, "eventId", command);
      const baseVersion = requireNumber(operation, "baseVersion", command);
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
        throw new Error(
          `invalid args \`${key}.baseVersion\` for command \`${command}\`: expected a non-negative safe integer`,
        );
      }
      if (kind === "eventSetLane") {
        for (const field of ["primaryCodexId", "laneGroup"] as const) {
          const laneValue = requirePresent(operation, field, command);
          if (
            laneValue !== null &&
            (typeof laneValue !== "string" || laneValue.length === 0)
          ) {
            throw new Error(
              `invalid args \`${key}.${field}\` for command \`${command}\`: expected null or a non-empty string`,
            );
          }
        }
      } else if (kind === "eventSetDate") {
        requireAbsoluteDate(operation, key);
      }
      target = `event:${eventId}`;
    } else if (
      kind === "sceneClearDate" ||
      kind === "sceneSetPov" ||
      kind === "sceneSetDate"
    ) {
      const sceneId = requireNonEmptyString(operation, "sceneId", command);
      requireNonEmptyString(operation, "baseUpdatedAt", command);
      if (kind === "sceneSetPov") {
        const pov = requirePresent(operation, "povCharacterId", command);
        if (pov !== null && (typeof pov !== "string" || pov.length === 0)) {
          throw new Error(
            `invalid args \`${key}.povCharacterId\` for command \`${command}\`: expected null or a non-empty string`,
          );
        }
      } else if (kind === "sceneSetDate") {
        requireAbsoluteDate(operation, key);
      }
      target = `scene:${sceneId}`;
    } else {
      throw new Error(
        `invalid args \`${key}.kind\` for command \`${command}\`: unsupported operation`,
      );
    }
    if (targets.has(target)) {
      throw new Error(
        `invalid args \`operations\` for command \`${command}\`: duplicate target ${target}`,
      );
    }
    targets.add(target);
  });
  return payload;
}

function requireUndoJournalPayload(args: CommandArgs): CommandArgs {
  const command = "agent_apply_undo_journal";
  const payload = requireRecord(args, "payload", command);
  requireNonEmptyString(payload, "requestId", command);
  requireNonEmptyString(payload, "projectId", command);
  requireNonEmptyString(payload, "sessionId", command);
  requireNonEmptyString(payload, "journalId", command);
  const direction = requireString(payload, "direction", command);
  if (direction !== "undo" && direction !== "redo") {
    throw new Error(
      `invalid args \`direction\` for command \`${command}\`: expected "undo" or "redo"`,
    );
  }
  if (requireString(payload, "authorityRoute", command) !== "history-replay") {
    throw new Error(
      `invalid authority route for command \`${command}\`: undo/redo requires history-replay`,
    );
  }
  if (requireString(payload, "origin", command) !== direction) {
    throw new Error(
      `invalid authority origin for command \`${command}\`: must match direction`,
    );
  }
  if (requireString(payload, "caller", command) !== "undo-redo-command") {
    throw new Error(
      `invalid authority caller for command \`${command}\`: expected undo-redo-command`,
    );
  }
  const controls = requireArray(payload, "controls", command);
  for (const control of [
    "original-transaction",
    "journal-lineage",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
  ]) {
    if (!controls.includes(control)) {
      throw new Error(
        `invalid authority controls for command \`${command}\`: missing ${control}`,
      );
    }
  }
  return payload;
}

/** Tauri の usize を napi の u32 へ安全に写像する（必須引数）。 */
function requireUnsignedInteger(
  args: CommandArgs,
  key: string,
  cmd: string,
): number {
  const value = args[key];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected an unsigned integer`,
    );
  }
  return value;
}

/** Optional provider output limit. Present values must fit the native u32 and
 * be strictly positive; zero would create an unusable request body. */
function validateOptionalPositiveU32(
  args: CommandArgs,
  key: string,
  cmd: string,
): void {
  const value = args[key];
  if (value === undefined || value === null) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a positive u32`,
    );
  }
}

const SQLITE_U64_MAX_DECIMAL = "18446744073709551615";

function isCanonicalU64Decimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return false;
  }
  return (
    value.length < SQLITE_U64_MAX_DECIMAL.length ||
    (value.length === SQLITE_U64_MAX_DECIMAL.length &&
      value <= SQLITE_U64_MAX_DECIMAL)
  );
}

/** Validate the Impact-only SQLite revision guard without changing nested keys. */
function validateOptionalSqliteSourceGuard(
  args: CommandArgs,
  cmd: string,
): void {
  const value = args.source_guard;
  if (value === undefined) {
    if (args.effect_type === "impact_review") {
      throw new Error(
        `invalid args \`source_guard\` for command \`${cmd}\`: required for impact_review`,
      );
    }
    return;
  }
  if (args.effect_type !== "impact_review") {
    throw new Error(
      `invalid args \`source_guard\` for command \`${cmd}\`: only impact_review may use a source guard`,
    );
  }
  const guard = requireRecord(args, "source_guard", cmd);
  const allowedKeys = new Set([
    "kind",
    "expected_connection_epoch",
    "expected_total_changes",
    "expected_data_version",
  ]);
  if (Object.keys(guard).some((key) => !allowedKeys.has(key))) {
    throw new Error(
      `invalid args \`source_guard\` for command \`${cmd}\`: unexpected key`,
    );
  }
  if (guard.kind !== "sqlite_revision_v1") {
    throw new Error(
      `invalid args \`source_guard.kind\` for command \`${cmd}\`: expected sqlite_revision_v1`,
    );
  }
  if (
    typeof guard.expected_connection_epoch !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      guard.expected_connection_epoch,
    )
  ) {
    throw new Error(
      `invalid args \`source_guard.expected_connection_epoch\` for command \`${cmd}\`: expected a canonical UUID`,
    );
  }
  for (const key of [
    "expected_total_changes",
    "expected_data_version",
  ] as const) {
    if (!isCanonicalU64Decimal(guard[key])) {
      throw new Error(
        `invalid args \`source_guard.${key}\` for command \`${cmd}\`: expected a canonical u64 decimal string`,
      );
    }
  }
}

/** Tauri の Option<i64> 引数の写像（欠落 / null / undefined は None）。 */
function optionalNumber(
  args: CommandArgs,
  key: string,
  cmd: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a number or null`,
    );
  }
  return value;
}

/** Tauri の Option<usize> を napi の Option<u32> へ安全に写像する。 */
function optionalUnsignedInteger(
  args: CommandArgs,
  key: string,
  cmd: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffff_ffff
  ) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected an unsigned integer or null`,
    );
  }
  return value;
}

const ENTITY_SEED_NORMALIZER_VERSION = "gdx-canonical-text/1";
const MAX_ENTITY_SEED_SOURCES = 900;
const MAX_ENTITY_SEED_OPAQUE_REF_BYTES = 1024;
const MAX_ENTITY_SEED_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ENTITY_SEED_RESPONSE_BYTES = 8 * 1024 * 1024;

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireExactEntitySeedKeys(
  value: CommandArgs,
  allowedKeys: readonly string[],
  path: string,
  command: string,
): void {
  const allowed = new Set(allowedKeys);
  const actual = Object.keys(value);
  if (
    actual.length !== allowedKeys.length ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new Error(
      `invalid args \`${path}\` for command \`${command}\`: expected exact fields ${allowedKeys.join(", ")}`,
    );
  }
}

function requireEntitySeedRecord(
  value: unknown,
  path: string,
  command: string,
): CommandArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `invalid args \`${path}\` for command \`${command}\`: expected an object`,
    );
  }
  return value as CommandArgs;
}

function requireEntitySeedOpaqueRef(
  value: CommandArgs,
  key: "sourceRef" | "documentRef",
  path: string,
  command: string,
): string {
  const ref = requireString(value, key, command);
  if (
    ref.length === 0 ||
    hasLoneUtf16Surrogate(ref) ||
    /\p{Cc}/u.test(ref) ||
    new TextEncoder().encode(ref).length > MAX_ENTITY_SEED_OPAQUE_REF_BYTES
  ) {
    throw new Error(
      `invalid args \`${path}.${key}\` for command \`${command}\`: expected a non-empty opaque reference of at most ${MAX_ENTITY_SEED_OPAQUE_REF_BYTES} UTF-8 bytes`,
    );
  }
  return ref;
}

function entitySeedRequestFromArgs(args: CommandArgs): CommandArgs {
  // The renderer facade sends the request fields directly. The nested form is
  // retained for the initial command-contract caller; both forms are exact.
  if (Object.keys(args).length === 1 && Object.hasOwn(args, "request")) {
    return requireEntitySeedRecord(
      requirePresent(args, "request", "extract_codex_entity_seeds"),
      "request",
      "extract_codex_entity_seeds",
    );
  }
  return args;
}

function requireExtractCodexEntitySeedsRequest(
  args: CommandArgs,
): ExtractCodexEntitySeedsRequestV1 {
  const command = "extract_codex_entity_seeds";
  const request = entitySeedRequestFromArgs(args);
  requireExactEntitySeedKeys(
    request,
    [
      "schemaVersion",
      "normalizerVersion",
      "language",
      "minimumOccurrenceCount",
      "sources",
    ],
    "request",
    command,
  );

  if (requirePresent(request, "schemaVersion", command) !== 1) {
    throw new Error(
      `invalid args \`schemaVersion\` for command \`${command}\`: expected 1`,
    );
  }
  if (
    requireString(request, "normalizerVersion", command) !==
    ENTITY_SEED_NORMALIZER_VERSION
  ) {
    throw new Error(
      `invalid args \`normalizerVersion\` for command \`${command}\`: unsupported canonical normalizer`,
    );
  }
  const language = requireNonEmptyString(request, "language", command);
  if (
    hasLoneUtf16Surrogate(language) ||
    /\p{Cc}/u.test(language) ||
    new TextEncoder().encode(language).length > 64
  ) {
    throw new Error(
      `invalid args \`language\` for command \`${command}\`: expected at most 64 UTF-8 bytes without control characters`,
    );
  }
  const minimumOccurrenceCount = requireNumber(
    request,
    "minimumOccurrenceCount",
    command,
  );
  if (
    !Number.isSafeInteger(minimumOccurrenceCount) ||
    minimumOccurrenceCount < 1 ||
    minimumOccurrenceCount > 0xffff_ffff
  ) {
    throw new Error(
      `invalid args \`minimumOccurrenceCount\` for command \`${command}\`: expected a positive u32 integer`,
    );
  }

  const sources = requireArray(request, "sources", command);
  if (sources.length > MAX_ENTITY_SEED_SOURCES) {
    throw new Error(
      `invalid args \`sources\` for command \`${command}\`: expected at most ${MAX_ENTITY_SEED_SOURCES} sources`,
    );
  }
  const sourceRefs = new Set<string>();
  for (const [index, candidate] of sources.entries()) {
    const path = `sources[${index}]`;
    const source = requireEntitySeedRecord(candidate, path, command);
    requireExactEntitySeedKeys(
      source,
      ["sourceRef", "documentRef", "documentRange", "text"],
      path,
      command,
    );
    const sourceRef = requireEntitySeedOpaqueRef(
      source,
      "sourceRef",
      path,
      command,
    );
    requireEntitySeedOpaqueRef(source, "documentRef", path, command);
    if (sourceRefs.has(sourceRef)) {
      throw new Error(
        `invalid args \`${path}.sourceRef\` for command \`${command}\`: duplicate source reference`,
      );
    }
    sourceRefs.add(sourceRef);

    const rangePath = `${path}.documentRange`;
    const range = requireEntitySeedRecord(
      requirePresent(source, "documentRange", command),
      rangePath,
      command,
    );
    requireExactEntitySeedKeys(range, ["start", "end"], rangePath, command);
    const start = requireNumber(range, "start", command);
    const end = requireNumber(range, "end", command);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > 0xffff_ffff
    ) {
      throw new Error(
        `invalid args \`${rangePath}\` for command \`${command}\`: expected a non-negative safe CanonicalRange`,
      );
    }

    const text = requireString(source, "text", command);
    if (hasLoneUtf16Surrogate(text)) {
      throw new Error(
        `invalid args \`${path}.text\` for command \`${command}\`: invalid UTF-16`,
      );
    }
    if (end - start !== text.length) {
      throw new Error(
        `invalid args \`${rangePath}\` for command \`${command}\`: range width must equal text UTF-16 length`,
      );
    }
  }

  const encodedRequest = new TextEncoder().encode(JSON.stringify(request));
  if (encodedRequest.length > MAX_ENTITY_SEED_REQUEST_BYTES) {
    throw new Error(
      `invalid args \`request\` for command \`${command}\`: encoded payload exceeds 8 MiB`,
    );
  }
  return request as unknown as ExtractCodexEntitySeedsRequestV1;
}

/** Tauri の Option<String> 引数の写像（欠落 / null は None。文字列以外は拒否）。 */
function optionalString(
  args: CommandArgs,
  key: string,
  cmd: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string or null`,
    );
  }
  return value;
}

/** Turn-start Agent protocol snapshot. Only the two resolved values are valid. */
function validateOptionalResolvedToolProtocol(
  args: CommandArgs,
  key: string,
  cmd: string,
): void {
  const value = optionalString(args, key, cmd);
  if (value === undefined) return;
  if (value !== "native" && value !== "hermes") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected native, hermes, or null`,
    );
  }
}

function requireNativeAiAuditContext(
  args: CommandArgs,
  command: string,
): CommandArgs {
  const context = requireRecord(args, "auditContext", command);
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "operationId",
    "executionId",
    "parentExecutionId",
    "pathId",
  ]);
  if (
    Object.keys(context).length !== allowedKeys.size ||
    Object.keys(context).some((key) => !allowedKeys.has(key))
  ) {
    throw new Error(
      `invalid args \`auditContext\` for command \`${command}\`: expected the exact native AI audit correlation fields`,
    );
  }
  for (const key of [
    "expectedWorkspacePath",
    "operationId",
    "executionId",
    "pathId",
  ]) {
    const value = context[key];
    if (
      typeof value !== "string" ||
      value.trim().length === 0 ||
      value !== value.trim()
    ) {
      throw new Error(
        `invalid args \`auditContext.${key}\` for command \`${command}\`: expected a non-empty trimmed string`,
      );
    }
  }
  for (const key of ["projectId", "parentExecutionId"] as const) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      throw new Error(
        `invalid args \`auditContext.${key}\` for command \`${command}\`: missing required key`,
      );
    }
    const value = context[key];
    if (
      value !== null &&
      (typeof value !== "string" ||
        value.trim().length === 0 ||
        value !== value.trim())
    ) {
      throw new Error(
        `invalid args \`auditContext.${key}\` for command \`${command}\`: expected a non-empty trimmed string or null`,
      );
    }
  }
  return context;
}

function requireNativeAiStreamCorrelation(
  args: CommandArgs,
  command: string,
): string {
  const context = requireNativeAiAuditContext(args, command);
  const streamId = requireNonEmptyString(args, "streamId", command);
  if (streamId !== streamId.trim()) {
    throw new Error(
      `invalid args \`streamId\` for command \`${command}\`: expected a trimmed string`,
    );
  }
  if (streamId !== context.executionId) {
    throw new Error(
      `invalid args \`streamId\` for command \`${command}\`: must equal auditContext.executionId`,
    );
  }
  return streamId;
}

function cliAuditPreconditionError(reason: string): Error {
  return new Error(`${AI_AUDIT_DISPATCH_PRECONDITION_FAILED_MARKER} ${reason}`);
}

interface CliDispatchRequestDigestInput {
  cli: string;
  model: string | null;
  prompt: string;
}

function cliDispatchRequestDigestInput(
  args: CommandArgs,
): CliDispatchRequestDigestInput {
  const payload = args.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw cliAuditPreconditionError("CLI payload is not an object");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.cli !== "string" || record.cli.trim() !== record.cli) {
    throw cliAuditPreconditionError("CLI payload.cli is invalid");
  }
  if (typeof record.prompt !== "string") {
    throw cliAuditPreconditionError("CLI payload.prompt is invalid");
  }
  const model = record.model;
  if (
    model !== undefined &&
    model !== null &&
    model !== "" &&
    typeof model !== "string"
  ) {
    throw cliAuditPreconditionError("CLI payload.model is invalid");
  }
  return {
    cli: record.cli,
    model: typeof model === "string" && model.length > 0 ? model : null,
    prompt: record.prompt,
  };
}

async function sha256HexUtf8(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw cliAuditPreconditionError("Web Crypto SHA-256 is unavailable");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function cliDispatchRequestSha256(args: CommandArgs): Promise<string> {
  const input = cliDispatchRequestDigestInput(args);
  return sha256HexUtf8(JSON.stringify(input));
}

/**
 * Main-side guard for the CLI shell command. The generic preload invoke path
 * must not be able to spawn a subprocess by supplying only a stream id and a
 * prompt. The native backend validates the pinned workspace, exact lifecycle,
 * prepared-request digest, and one-shot claim in one SQLite transaction before
 * the shell handler is allowed to resolve or spawn a binary.
 */
async function assertCliAiAuditDispatchPrecondition(
  args: CommandArgs,
  backend: NapiBackendLike | null,
): Promise<void> {
  const command = "send_cli_chat_stream";
  const context = requireNativeAiAuditContext(args, command);
  requireNativeAiStreamCorrelation(args, command);
  if (!backend) {
    throw cliAuditPreconditionError("native audit backend is unavailable");
  }

  const expectedWorkspacePath = context.expectedWorkspacePath as string;
  const projectId = context.projectId as string | null;
  const operationId = context.operationId as string;
  const executionId = context.executionId as string;
  const parentExecutionId = context.parentExecutionId as string | null;
  const pathId = context.pathId as string;
  if (typeof backend.aiAuditClaimCliDispatch !== "function") {
    throw cliAuditPreconditionError("native CLI dispatch claim is unavailable");
  }
  const expectedRequestSha256 = await cliDispatchRequestSha256(args);
  await backend.aiAuditClaimCliDispatch(
    expectedWorkspacePath,
    projectId,
    executionId,
    operationId,
    parentExecutionId,
    pathId,
    expectedRequestSha256,
  );
}

function requireStreamId(args: CommandArgs, command: string): string {
  const streamId = requireNonEmptyString(args, "streamId", command);
  if (streamId !== streamId.trim()) {
    throw new Error(
      `invalid args \`streamId\` for command \`${command}\`: expected a trimmed string`,
    );
  }
  return streamId;
}

/** FE生成のrun discriminator。空値/過長値をイベントpayloadへ持ち込ませない。 */
function optionalOpaqueRunId(
  args: CommandArgs,
  key: string,
  cmd: string,
): string | undefined {
  const value = optionalString(args, key, cmd);
  if (value === undefined) return undefined;
  // Rust/Tauri側の `chars().count()` と揃え、astral characterをUTF-16の2単位で
  // 数えない（emoji 256 code pointは受理、257は拒否）。
  const codePointLength = Array.from(value).length;
  if (codePointLength < 1 || codePointLength > 256) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected 1..256 characters or null`,
    );
  }
  return value;
}

/** Tauri の Option<bool>（欠落 / null / undefined は None）。 */
function optionalBoolean(
  args: CommandArgs,
  key: string,
  cmd: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a boolean or null`,
    );
  }
  return value;
}

/** Tauri の Option<String> を napi へ渡す際、明示 null を失わない写像。 */
function nullableString(
  args: CommandArgs,
  key: string,
  cmd: string,
): string | null | undefined {
  const value = args[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string or null`,
    );
  }
  return value;
}

/** napi は JSON 文字列を返す（Tauri ワイヤと同形にするため parse して返す）。 */
function parseWire(json: string): unknown {
  return JSON.parse(json) as unknown;
}

/**
 * `reply_to_annotation` commits a local DB row, but Native's read-back row
 * contains the reply body and other annotation plaintext.  Keep the local
 * mutation usable while returning only the opaque generated id over IPC.
 */
function parseOpaqueReplyToAnnotation(json: string): unknown {
  const value = parseWire(json);
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === "string" &&
    (value as Record<string, string>).id.trim() ===
      (value as Record<string, string>).id &&
    (value as Record<string, string>).id.length > 0
  ) {
    return { id: (value as Record<string, string>).id };
  }
  throw new Error("reply_to_annotation returned no opaque id");
}

function parseEntitySeedWire(json: string): unknown {
  if (
    json.length > MAX_ENTITY_SEED_RESPONSE_BYTES ||
    new TextEncoder().encode(json).length > MAX_ENTITY_SEED_RESPONSE_BYTES
  ) {
    throw new Error("entity seed response exceeds the 8 MiB wire budget");
  }
  return parseWire(json);
}

/** native mutationは既にcommit済みなので、window配信失敗でinvokeを失敗へ反転しない。 */
function broadcastBestEffort(
  deps: DispatchDeps,
  channel: string,
  payload: unknown,
): void {
  try {
    deps.broadcast?.(channel, payload);
  } catch {
    // Do not send thrown values to the production console: they may contain
    // payload fragments, SQL params, or a stack with workspace paths.
    console.warn(`[ipc] ${channel} broadcast failed`);
  }
}

/** validate失敗も「検証を試みた」事実なので、現在stateを全窓へ同期する。 */
async function broadcastCurrentLicenseStateBestEffort(
  backend: NapiBackendLike,
  deps: DispatchDeps,
): Promise<void> {
  if (!deps.broadcast) return;
  try {
    const state = parseWire(
      await requireNapiMethod(
        backend,
        backend.getLicenseState,
        "getLicenseState",
      )(),
    );
    broadcastBestEffort(deps, "license:state_changed", state);
  } catch {
    console.warn("[ipc] failed to read license state after revalidate error");
  }
}

export interface NapiCommandSpec {
  /**
   * FE 引数（Tauri 命名 = camelCase キー）→ Backend メソッド呼び出しへの
   * 明示写像。JSON 文字列返りは parse 済みオブジェクトにして Tauri の
   * invoke 返り値と同形にする。
   *
   * `deps` は AI チャット等がキー解決（secrets）を必要とするため渡す。大半の
   * コマンドは backend / args のみで完結し `deps` を使わない。
   */
  run(
    backend: NapiBackendLike,
    args: CommandArgs,
    deps: DispatchDeps,
  ): Promise<unknown>;
}

function requireRelatedScenesBeginRequest(args: CommandArgs) {
  const command = "related_scenes_begin";
  const query = requireNonEmptyString(args, "query", command);
  if (query.trim().length === 0 || query.length > 500) {
    throw new Error("IPC_INVALID_REQUEST: related_scenes_begin query exceeds Raw UTF-16 tail");
  }
  return {
    ownerKey: requireNonEmptyString(args, "ownerKey", command),
    expectedWorkspacePath: requireNonEmptyString(args, "expectedWorkspacePath", command),
    projectId: requireNonEmptyString(args, "projectId", command),
    currentSceneId: requireNonEmptyString(args, "currentSceneId", command),
    query,
  };
}

function requireNir1EntityRelationRevisionCreateRequest(
  args: CommandArgs,
): readonly [CommandArgs, CommandArgs] {
  const command = "nir1_entity_relation_revision_create";
  const [rawPayload, workspaceBinding] = requireNarrativeExtractionBoundMutation(
    args,
    command,
  );
  const payload = requireRecord({ payload: rawPayload }, "payload", command);
  const allowedKeys = new Set(["runId", "projectId", "proposalKey", "bundle"]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: unknown field`,
      );
    }
  }
  for (const key of ["runId", "projectId", "proposalKey"] as const) {
    const value = requireNonEmptyString(payload, key, command);
    if (value.trim() !== value) {
      throw new Error(
        `invalid args \`${key}\` for command \`${command}\`: expected an exact string`,
      );
    }
  }
  const bundle = requireRecord(payload, "bundle", command);
  for (const key of ["projectId", "revisionId", "producer", "entities", "relations"]) {
    requirePresent(bundle, key, command);
  }
  return [payload, workspaceBinding];
}

function requireNir1PackingRequest(args: CommandArgs): CommandArgs {
  const command = "nir1_pack_context";
  const payload = requireRecord(args, "payload", command);
  const budgetTokens = requireUnsignedInteger(payload, "budgetTokens", command);
  if (budgetTokens === 0) {
    throw new Error(
      `invalid args \`payload.budgetTokens\` for command \`${command}\`: expected a positive integer`,
    );
  }
  const rawItems = requirePresent(payload, "items", command);
  if (!Array.isArray(rawItems) || rawItems.length > 512) {
    throw new Error(
      `invalid args \`payload.items\` for command \`${command}\`: expected at most 512 items`,
    );
  }
  const items = rawItems.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(
        `invalid args \`payload.items[${index}]\` for command \`${command}\`: expected an object`,
      );
    }
    const item = value as CommandArgs;
    const kind = requireNonEmptyString(item, "kind", command);
    if (
      ![
        "raw",
        "acceptedIr",
        "graphEvidence",
        "authorDeclared",
        "unreviewedForReview",
      ].includes(kind)
    ) {
      throw new Error(
        `invalid args \`payload.items[${index}].kind\` for command \`${command}\`: unsupported context kind`,
      );
    }
    const base = {
      kind,
      id: requireNonEmptyString(item, "id", command),
      text: requireNonEmptyString(item, "text", command),
      tokens: requireUnsignedInteger(item, "tokens", command),
    };
    if (base.tokens === 0) {
      throw new Error(
        `invalid args \`payload.items[${index}].tokens\` for command \`${command}\`: expected a positive integer`,
      );
    }
    return kind === "raw"
      ? base
      : {
          ...base,
          atomicGroup: requireNonEmptyString(item, "atomicGroup", command),
        };
  });
  return { budgetTokens, items };
}

function requireSceneScopeReadRequest(args: CommandArgs): CommandArgs {
  const command = "narrative_scene_scope_read";
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "projectId",
    "sceneId",
    // Main-only D2a identity is checked by electron/main/profileEgress.ts;
    // this Native A1 reader does not need it and must not forward it into its
    // deny-unknown-fields request.
    "callerIdentity",
  ]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`invalid args \`${key}\` for command \`${command}\`: unknown field`);
    }
  }
  return {
    expectedWorkspacePath: requireNonEmptyString(args, "expectedWorkspacePath", command),
    projectId: requireNonEmptyString(args, "projectId", command),
    sceneId: requireNonEmptyString(args, "sceneId", command),
  };
}

function requireSceneScopeMutationRequest(args: CommandArgs, command: string): CommandArgs {
  const allowedKeys = new Set([
    "expectedWorkspacePath",
    "payload",
    // Main-only D2a identity is checked by electron/main/profileEgress.ts;
    // A1 writers remain Native-authority-bound without forwarding it into the
    // deny-unknown-fields request.
    "callerIdentity",
  ]);
  for (const key of Object.keys(args)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`invalid args \`${key}\` for command \`${command}\`: unknown field`);
    }
  }
  const payload = requireRecord(args, "payload", command);
  const requiredKeys = command === "narrative_scene_scope_update"
    ? ["projectId", "sceneId", "requestId", "sessionId", "eventUid", "baseVersion", "updatedAt", "scope"]
    : ["projectId", "requestId", "sessionId", "eventUid", "baseVersion", "updatedAt", "registry"];
  for (const key of requiredKeys) {
    requirePresent(payload, key, command);
  }
  if (typeof payload.baseVersion !== "number" || !Number.isSafeInteger(payload.baseVersion) || payload.baseVersion < 1) {
    throw new Error(`invalid args \`payload.baseVersion\` for command \`${command}\`: expected a positive safe integer`);
  }
  return {
    expectedWorkspacePath: requireNonEmptyString(args, "expectedWorkspacePath", command),
    payload,
  };
}

/** napi 実装済みコマンドの明示写像（Phase 3 の各バッチで追加）。 */
export const NAPI_COMMANDS: Readonly<Record<string, NapiCommandSpec>> = {
  db_execute: {
    run: async (b, a) =>
      parseWire(
        await b.dbExecute(
          requireString(a, "sql", "db_execute"),
          requirePresent(a, "params", "db_execute"),
          requireString(a, "method", "db_execute"),
        ),
      ),
  },
  db_execute_batch: {
    run: async (b, a) =>
      parseWire(
        await b.dbExecuteBatch(
          requirePresent(a, "statements", "db_execute_batch"),
        ),
      ),
  },
  narrative_runtime_policy_get: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeRuntimePolicyGet,
          "narrativeRuntimePolicyGet",
        )(),
      ),
  },
  narrative_runtime_policy_set: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeRuntimePolicySet,
          "narrativeRuntimePolicySet",
        )(requireNarrativeRuntimePolicySetPayload(a)),
      ),
  },
  editor_sticky_list: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.editorStickyList,
          "editorStickyList",
        )(
          requireNonEmptyString(a, "projectId", "editor_sticky_list"),
          requireNonEmptyString(a, "documentKey", "editor_sticky_list"),
        ),
      ),
  },
  editor_sticky_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.editorStickyCreate,
          "editorStickyCreate",
        )(requireEditorStickyCreatePayload(a)),
      ),
  },
  editor_sticky_update: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.editorStickyUpdate,
          "editorStickyUpdate",
        )(requireEditorStickyUpdatePayload(a)),
      ),
  },
  editor_sticky_delete: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.editorStickyDelete,
        "editorStickyDelete",
      )(requireEditorStickyDeletePayload(a));
      return null;
    },
  },
  lint_ignore_list: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintIgnoreList,
          "lintIgnoreList",
        )(requireNonEmptyString(a, "projectId", "lint_ignore_list")),
      ),
  },
  lint_ignore_list_scene: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintIgnoreListScene,
          "lintIgnoreListScene",
        )(
          requireNonEmptyString(a, "projectId", "lint_ignore_list_scene"),
          requireNonEmptyString(a, "sceneId", "lint_ignore_list_scene"),
        ),
      ),
  },
  lint_ignore_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintIgnoreCreate,
          "lintIgnoreCreate",
        )(requireLintIgnoreCreatePayload(a)),
      ),
  },
  lint_ignore_delete: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.lintIgnoreDelete,
        "lintIgnoreDelete",
      )(
        requireNonEmptyString(a, "projectId", "lint_ignore_delete"),
        requireNonEmptyString(a, "id", "lint_ignore_delete"),
      );
      return null;
    },
  },
  lint_ignore_copy: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintIgnoreCopy,
          "lintIgnoreCopy",
        )(requireLintIgnoreCopyPayload(a)),
      ),
  },
  lint_ignore_move: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintIgnoreMove,
          "lintIgnoreMove",
        )(requireLintIgnoreMovePayload(a)),
      ),
  },
  lint_term_dictionary_list: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintTermDictionaryList,
          "lintTermDictionaryList",
        )(requireNonEmptyString(a, "projectId", "lint_term_dictionary_list")),
      ),
  },
  lint_term_dictionary_insert: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintTermDictionaryInsert,
          "lintTermDictionaryInsert",
        )(requireLintTermDictionaryPayload(a, "lint_term_dictionary_insert")),
      ),
  },
  lint_term_dictionary_update: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintTermDictionaryUpdate,
          "lintTermDictionaryUpdate",
        )(requireLintTermDictionaryPayload(a, "lint_term_dictionary_update")),
      ),
  },
  lint_term_dictionary_set_enabled: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.lintTermDictionarySetEnabled,
          "lintTermDictionarySetEnabled",
        )(
          requireNonEmptyString(
            a,
            "projectId",
            "lint_term_dictionary_set_enabled",
          ),
          requireNonEmptyString(a, "id", "lint_term_dictionary_set_enabled"),
          requireBoolean(a, "enabled", "lint_term_dictionary_set_enabled"),
          requireSafeInteger(
            a,
            "updatedAt",
            "lint_term_dictionary_set_enabled",
          ),
        ),
      ),
  },
  lint_term_dictionary_delete: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.lintTermDictionaryDelete,
        "lintTermDictionaryDelete",
      )(
        requireNonEmptyString(a, "projectId", "lint_term_dictionary_delete"),
        requireNonEmptyString(a, "id", "lint_term_dictionary_delete"),
      );
      return null;
    },
  },
  event_get_version: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventGetVersion,
          "eventGetVersion",
        )(
          requireNonEmptyString(a, "projectId", "event_get_version"),
          requireNonEmptyString(a, "eventId", "event_get_version"),
        ),
      ),
  },
  event_set_participants: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventSetParticipants,
          "eventSetParticipants",
        )(requireEventSetParticipantsPayload(a)),
      ),
  },
  project_calendar_upsert: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.projectCalendarUpsert,
          "projectCalendarUpsert",
        )(requireProjectCalendarUpsertPayload(a)),
      ),
  },
  authorship_replace_lane: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.authorshipReplaceLane,
        "authorshipReplaceLane",
      )(requireAuthorshipReplaceLanePayload(a));
      return null;
    },
  },
  entity_tags_set: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.entityTagsSet,
        "entityTagsSet",
      )(requireEntityTagsSetPayload(a));
      return null;
    },
  },
  codex_rename_undo: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexRenameUndo,
          "codexRenameUndo",
        )(requireCodexRenameUndoPayload(a)),
      ),
  },
  codex_rename_apply: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexRenameApply,
          "codexRenameApply",
        )(requireCodexRenameApplyPayload(a)),
      ),
  },
  scan_staging_project_create: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.scanStagingProjectCreate,
        "scanStagingProjectCreate",
      )(requireScanStagingProjectCreatePayload(a));
      return null;
    },
  },
  scan_staging_project_publish: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.scanStagingProjectPublish,
          "scanStagingProjectPublish",
        )(requireScanStagingProjectPublishPayload(a)),
      ),
  },
  project_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.projectCreate,
          "projectCreate",
        )(requireProjectCreatePayload(a)),
      ),
  },
  project_patch: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.projectPatch,
          "projectPatch",
        )(requireProjectPatchPayload(a)),
      ),
  },
  project_delete: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.projectDelete,
        "projectDelete",
      )(requireProjectDeletePayload(a));
      return null;
    },
  },
  ai_tree_plan_apply: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.aiTreePlanApply,
          "aiTreePlanApply",
        )(requireAiTreePlanApplyPayload(a)),
      ),
  },
  ai_tree_plan_undo: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.aiTreePlanUndo,
          "aiTreePlanUndo",
        )(requireAiTreePlanUndoPayload(a)),
      ),
  },
  tree_node_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.treeNodeCreate,
          "treeNodeCreate",
        )(requireTreeNodeCreatePayload(a)),
      ),
  },
  tree_node_delete: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.treeNodeDelete,
          "treeNodeDelete",
        )(requireTreeNodeDeletePayload(a)),
      ),
  },
  tree_node_patch: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.treeNodePatch,
          "treeNodePatch",
        )(requireTreeNodePatchPayload(a)),
      ),
  },
  temporal_scene_patch: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.temporalScenePatch,
          "temporalScenePatch",
        )(requireTemporalScenePatchPayload(a)),
      ),
  },
  map_write_bundle: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.mapWriteBundle,
          "mapWriteBundle",
        )(requireMapWritePayload(a)),
      ),
  },
  project_snapshot_create: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.projectSnapshotCreate,
        "projectSnapshotCreate",
      )(requireProjectSnapshotCreatePayload(a));
      return null;
    },
  },
  project_snapshot_restore_context: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.projectSnapshotRestoreContext,
          "projectSnapshotRestoreContext",
        )(
          requireNonEmptyString(
            a,
            "projectId",
            "project_snapshot_restore_context",
          ),
          requireNonEmptyString(
            a,
            "snapshotId",
            "project_snapshot_restore_context",
          ),
          requireProjectSnapshotScopes(
            a,
            "scopes",
            "project_snapshot_restore_context",
          ),
        ),
      ),
  },
  project_snapshot_apply_restore: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.projectSnapshotApplyRestore,
          "projectSnapshotApplyRestore",
        )(requireProjectSnapshotApplyPayload(a)),
      ),
  },
  revision_scene_restore: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.revisionSceneRestore,
          "revisionSceneRestore",
        )(requireRevisionSceneRestorePayload(a)),
      ),
  },
  save_scene_body_bundle: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.saveSceneBodyBundle,
          "saveSceneBodyBundle",
        )(requireSceneBodyBundlePayload(a)),
      ),
  },
  runtime_performance_seed: {
    run: async (b, a) => {
      const { ownerToken, payload } = requireRuntimePerformanceSeedArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.runtimePerformanceSeed,
          "runtimePerformanceSeed",
        )(ownerToken, payload),
      );
    },
  },
  vacuum_database: {
    run: async (b) => {
      await b.vacuumDatabase();
      return null;
    },
  },
  open_workspace: {
    run: async (b, a) =>
      parseWire(
        await b.openWorkspace(requireString(a, "path", "open_workspace")),
      ),
  },
  validate_workspace_path: {
    run: (b, a) =>
      Promise.resolve(
        b.validateWorkspacePath(
          requireString(a, "path", "validate_workspace_path"),
        ),
      ),
  },
  list_backups: {
    run: async (b) =>
      parseWire(await requireNapiMethod(b, b.listBackups, "listBackups")()),
  },
  restore_backup: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.restoreBackup,
        "restoreBackup",
      )(requireBackupFileName(a));
      return null;
    },
  },
  list_recovery_candidates: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.listRecoveryCandidates,
          "listRecoveryCandidates",
        )(),
      ),
  },
  verify_recovery_candidate: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.verifyRecoveryCandidate,
          "verifyRecoveryCandidate",
        )(requireRecoveryCandidateId(a, "verify_recovery_candidate")),
      ),
  },
  restore_recovery_candidate: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.restoreRecoveryCandidate,
        "restoreRecoveryCandidate",
      )(requireRecoveryCandidateId(a, "restore_recovery_candidate"));
      return null;
    },
  },
  quarantine_live_database: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.quarantineLiveDatabase,
          "quarantineLiveDatabase",
        )(),
      ),
  },
  export_safe_mode_diagnostics: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.exportSafeModeDiagnostics,
          "exportSafeModeDiagnostics",
        )(),
      ),
  },
  get_global_settings: {
    run: async (b) => parseWire(await b.getGlobalSettings()),
  },
  save_global_settings: {
    // Tauri の unit 返りコマンドは null を resolve する（ワイヤ同形）
    run: async (b, a) => {
      await b.saveGlobalSettings(
        requirePresent(a, "settings", "save_global_settings"),
      );
      return null;
    },
  },
  seed_sample_workspace: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.seedSampleWorkspace,
          "seedSampleWorkspace",
        )(
          requireString(a, "language", "seed_sample_workspace"),
          requireString(a, "aiPolicy", "seed_sample_workspace"),
        ),
      ),
  },
  import_web_editor_workspace: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.importWebEditorWorkspace,
          "importWebEditorWorkspace",
        )(requireString(a, "handoffJson", "import_web_editor_workspace")),
      ),
  },
  timelapse_append_batch: {
    run: async (b, a) =>
      parseWire(
        await b.timelapseAppendBatch(
          requireString(a, "projectId", "timelapse_append_batch"),
          requireString(a, "sessionId", "timelapse_append_batch"),
          requirePublicTimelapseAppendEvents(a, "timelapse_append_batch"),
        ),
      ),
  },
  timelapse_genesis_baselines_append: {
    run: async (b, a) => {
      const input = requireTimelapseGenesisBaselinesAppendArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.timelapseGenesisBaselinesAppend,
          "timelapseGenesisBaselinesAppend",
        )(
          input.expectedWorkspacePath,
          input.projectId,
          input.kind,
          input.entityIds,
          input.anchorTimestamp,
        ),
      );
    },
  },
  timelapse_body_baselines_append: {
    run: async (b, a) => {
      const input = requireTimelapseBodyBaselinesAppendArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.timelapseBodyBaselinesAppend,
          "timelapseBodyBaselinesAppend",
        )(
          input.expectedWorkspacePath,
          input.projectId,
          input.targets,
          input.expectedAnchorSequence,
        ),
      );
    },
  },
  timelapse_history_purge: {
    run: async (b, a) => {
      const input = requireTimelapseHistoryPurgeArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.timelapseHistoryPurge,
          "timelapseHistoryPurge",
        )(input.expectedWorkspacePath, input.projectId),
      );
    },
  },
  timelapse_enabled_set: {
    run: async (b, a) => {
      const input = requireTimelapseEnabledSetArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.timelapseEnabledSet,
          "timelapseEnabledSet",
        )(input.expectedWorkspacePath, input.projectId, input.enabled),
      );
    },
  },
  timelapse_layout_snapshot_record: {
    run: async (b, a) => {
      const input = requireTimelapseLayoutSnapshotRecordArgs(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.timelapseLayoutSnapshotRecord,
          "timelapseLayoutSnapshotRecord",
        )(
          input.expectedWorkspacePath,
          input.projectId,
          input.payload,
          input.expectedAnchorSequence,
        ),
      );
    },
  },
  ai_audit_append_batch: {
    run: async (b, a) =>
      parseWire(
        await b.aiAuditAppendBatch(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "ai_audit_append_batch",
          ),
          requireAiAuditProjectId(a, "ai_audit_append_batch"),
          requireAiAuditEvents(a),
        ),
      ),
  },
  ai_audit_read_snapshot: {
    run: async (b, a) =>
      parseWire(
        await b.aiAuditReadSnapshot(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "ai_audit_read_snapshot",
          ),
          requireAiAuditProjectId(a, "ai_audit_read_snapshot"),
          optionalNonNegativeSafeInteger(
            a,
            "afterSequence",
            "ai_audit_read_snapshot",
          ),
          optionalNonNegativeSafeInteger(
            a,
            "highWaterSequence",
            "ai_audit_read_snapshot",
          ),
          optionalAiAuditPageLimit(a, "ai_audit_read_snapshot"),
        ),
      ),
  },
  ai_audit_verify: {
    run: async (b, a) =>
      parseWire(
        await b.aiAuditVerify(
          requireNonEmptyString(a, "expectedWorkspacePath", "ai_audit_verify"),
          requireAiAuditProjectId(a, "ai_audit_verify"),
          optionalNonNegativeSafeInteger(
            a,
            "highWaterSequence",
            "ai_audit_verify",
          ),
        ),
      ),
  },
  // IME 連携 Phase 2。status は napi の JSON 文字列を typed renderer の
  // camelCase object に戻し、unit コマンドは null を返す。
  ime_export_refresh: {
    run: async (b, a) =>
      parseWire(
        await b.imeExportRefresh(
          requireString(a, "projectId", "ime_export_refresh"),
          requireString(a, "expectedWorkspacePath", "ime_export_refresh"),
          requirePresent(a, "options", "ime_export_refresh"),
        ),
      ),
  },
  ime_export_set_active_project: {
    run: async (b, a) =>
      parseWire(
        await b.imeExportSetActiveProject(
          nullableString(a, "projectId", "ime_export_set_active_project"),
          nullableString(
            a,
            "expectedWorkspacePath",
            "ime_export_set_active_project",
          ),
          requireString(a, "mode", "ime_export_set_active_project"),
        ),
      ),
  },
  ime_export_get_status: {
    run: async (b, a) =>
      parseWire(
        await b.imeExportGetStatus(
          requireString(a, "mode", "ime_export_get_status"),
        ),
      ),
  },
  ime_export_clear_all: {
    run: async (b) => {
      await b.imeExportClearAll();
      return null;
    },
  },
  ime_export_remove_project: {
    run: async (b, a) => {
      await b.imeExportRemoveProject(
        requireString(a, "projectId", "ime_export_remove_project"),
        requireString(a, "expectedWorkspacePath", "ime_export_remove_project"),
      );
      return null;
    },
  },
  // trash_bin commands（起動時の trash_bin_list IPC_UNIMPLEMENTED 修正 +
  // structural restore の Native atomic aggregate）。
  // Tauri 側 fn 署名（src-tauri/src/commands/trash_bin.rs）との対応:
  //   create(payload: TrashBinCreatePayload) — struct 内は serde rename_all の
  //   camelCase なので {payload} をそのまま素通しする
  //   list(project_id, limit: Option<i64>) / delete(id) / clear_all(project_id)
  //   prune(project_id, retention_days, max_count)
  trash_bin_create: {
    run: async (b, a) =>
      parseWire(
        await b.trashBinCreate(
          requirePresent(a, "payload", "trash_bin_create"),
        ),
      ),
  },
  trash_bin_restore: {
    run: async (b, a) =>
      parseWire(await b.trashBinRestore(requireTrashBinRestorePayload(a))),
  },
  trash_bin_list: {
    run: async (b, a) =>
      parseWire(
        await b.trashBinList(
          requireString(a, "projectId", "trash_bin_list"),
          optionalNumber(a, "limit", "trash_bin_list"),
        ),
      ),
  },
  trash_bin_delete: {
    // Tauri の unit 返りコマンドは null を resolve する（ワイヤ同形）
    run: async (b, a) => {
      await b.trashBinDelete(requireString(a, "id", "trash_bin_delete"));
      return null;
    },
  },
  trash_bin_clear_all: {
    run: async (b, a) => {
      await b.trashBinClearAll(
        requireString(a, "projectId", "trash_bin_clear_all"),
      );
      return null;
    },
  },
  trash_bin_prune: {
    run: async (b, a) =>
      parseWire(
        await b.trashBinPrune(
          requireString(a, "projectId", "trash_bin_prune"),
          requireNumber(a, "retentionDays", "trash_bin_prune"),
          requireNumber(a, "maxCount", "trash_bin_prune"),
        ),
      ),
  },
  // integrity / FTS 6 コマンド（Phase 3 バッチ1 — 実装本体は grimodex-db の
  // Database メソッドを Tauri と共用。コード移動なしの直接写像）。
  // Tauri 側 fn 署名（src-tauri/src/commands/integrity.rs）:
  //   fts_optimize() / fts_rebuild() / fts_rebuild_en() /
  //   fts_search(project_id, query, scope, limit: u32) /
  //   integrity_check(project_id) / repair_integrity(payload)
  fts_optimize: {
    run: async (b) => {
      await b.ftsOptimize();
      return null;
    },
  },
  fts_rebuild: {
    run: async (b) => {
      await b.ftsRebuild();
      return null;
    },
  },
  fts_rebuild_en: {
    run: async (b) => {
      await b.ftsRebuildEn();
      return null;
    },
  },
  fts_search: {
    run: async (b, a) =>
      parseWire(
        await b.ftsSearch(
          requireString(a, "projectId", "fts_search"),
          requireString(a, "query", "fts_search"),
          requireString(a, "scope", "fts_search"),
          requireNumber(a, "limit", "fts_search"),
        ),
      ),
  },
  integrity_check: {
    run: async (b, a) =>
      parseWire(
        await b.integrityCheck(
          requireString(a, "projectId", "integrity_check"),
        ),
      ),
  },
  repair_integrity: {
    run: async (b, a) => {
      const command = "repair_integrity";
      const payload = requireRecord(a, "payload", command);
      for (const key of [
        "projectId",
        "requestId",
        "sessionId",
        "eventUid",
        "occurredAt",
      ]) {
        requireNonEmptyString(payload, key, command);
      }
      return parseWire(await b.repairIntegrity(payload));
    },
  },
  // lint / reorder / fonts（Phase 3 バッチ1b — grimodex-lint / grimodex-fonts
  // を Tauri と共用）。Tauri 側 fn 署名:
  //   lint_text(blocks, language, scope, config, disables: Option<…>) —
  //     エラーは LintError の {type,data} object（napi は reason に JSON を
  //     載せるため、ここで parse して WireErrorValue へ復元する）
  //   segment_bunsetsu(text) / list_system_fonts()
  lint_text: {
    run: async (b, a) => {
      try {
        return parseWire(
          await b.lintText(
            requirePresent(a, "blocks", "lint_text"),
            requireString(a, "language", "lint_text"),
            requirePresent(a, "scope", "lint_text"),
            requirePresent(a, "config", "lint_text"),
            a.disables,
          ),
        );
      } catch (e) {
        throw restoreLintWireError(e);
      }
    },
  },
  segment_bunsetsu: {
    run: async (b, a) =>
      parseWire(
        await b.segmentBunsetsu(requireString(a, "text", "segment_bunsetsu")),
      ),
  },
  list_system_fonts: {
    run: async (b) => parseWire(await b.listSystemFonts()),
  },
  // Codex 名寄せマッチャ（Phase 3 バッチ1c — grimodex-core::codex_matching を
  // Tauri と共用）。Tauri 側 fn 署名（src-tauri/src/codex_matching.rs）:
  //   codex_rebuild_matcher(entries: Vec<MatchEntry>) — {entries} を素通し
  //   codex_match_text(text, exclude_entry_ids) — camelCase excludeEntryIds
  codex_rebuild_matcher: {
    // unit 返りコマンドは null を resolve（ワイヤ同形）
    run: async (b, a) => {
      await b.codexRebuildMatcher(
        requirePresent(a, "entries", "codex_rebuild_matcher"),
      );
      return null;
    },
  },
  codex_match_text: {
    run: async (b, a) => {
      const exclude = a.excludeEntryIds;
      const excludeIds = Array.isArray(exclude)
        ? exclude.filter((e): e is string => typeof e === "string")
        : [];
      return parseWire(
        await b.codexMatchText(
          requireString(a, "text", "codex_match_text"),
          excludeIds,
        ),
      );
    },
  },
  // Codex 未確定候補 (Phase 3 Batch 4)。Tauri 側 Option<usize> は main 境界で
  // u32 に狭めて検証し、native は開始時に active DB を pin してから解析する。
  extract_codex_candidates: {
    run: async (b, a) =>
      parseWire(
        await b.extractCodexCandidates(
          requireString(a, "projectId", "extract_codex_candidates"),
          optionalUnsignedInteger(a, "minCount", "extract_codex_candidates"),
        ),
      ),
  },
  extract_codex_entity_seeds: {
    run: async (b, a) => {
      const request = requireExtractCodexEntitySeedsRequest(a);
      return parseEntitySeedWire(
        await requireNapiMethod(
          b,
          b.extractCodexEntitySeeds,
          "extractCodexEntitySeeds",
        )(request),
      );
    },
  },
  // Semantic Phase 3 Batch 4。native methodsはversion skewを許容する構造型にし、
  // 実行時は必ず存在検証する。JSON文字列をparseしてTauri invokeと同じwireへ戻す。
  semantic_download_model: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticDownloadModel,
          "semanticDownloadModel",
        )(requireString(a, "language", "semantic_download_model")),
      ),
  },
  semantic_cancel_background: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticCancelBackground,
          "semanticCancelBackground",
        )(),
      ),
  },
  semantic_index_scene: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.semanticIndexScene, "semanticIndexScene")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "semantic_index_scene",
          ),
          requireNonEmptyString(a, "projectId", "semantic_index_scene"),
          requireString(a, "sceneId", "semantic_index_scene"),
        ),
      ),
  },
  semantic_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.semanticSearch, "semanticSearch")(
          requireNonEmptyString(a, "expectedWorkspacePath", "semantic_search"),
          requireString(a, "projectId", "semantic_search"),
          requireString(a, "query", "semantic_search"),
          requireUnsignedInteger(a, "limit", "semantic_search"),
          optionalString(a, "sceneScope", "semantic_search"),
          optionalBoolean(a, "descriptionMode", "semantic_search"),
        ),
      ),
  },
  related_scenes_begin: {
    run: async (b, a) => parseWire(
      await requireNapiMethod(b, b.relatedScenesBegin, "relatedScenesBegin")(
        requireRelatedScenesBeginRequest(a),
      ),
    ),
  },
  related_scenes_continue: {
    run: async (b, a) => parseWire(
      await requireNapiMethod(b, b.relatedScenesContinue, "relatedScenesContinue")(
        requireNonEmptyString(a, "ownerKey", "related_scenes_continue"),
        requireNonEmptyString(a, "operationTicket", "related_scenes_continue"),
      ),
    ),
  },
  related_scenes_release: {
    run: async (b, a) => parseWire(
      await requireNapiMethod(b, b.relatedScenesRelease, "relatedScenesRelease")(
        requireNonEmptyString(a, "ownerKey", "related_scenes_release"),
        requireNonEmptyString(a, "operationTicket", "related_scenes_release"),
      ),
    ),
  },
  nir1_evidence_qualify: {
    run: async (b, a) => parseWire(
      await requireNapiMethod(b, b.nir1EvidenceQualify, "nir1EvidenceQualify")(
        requireNonEmptyString(a, "ownerKey", "nir1_evidence_qualify"),
        requireNonEmptyString(a, "navigationIdentity", "nir1_evidence_qualify"),
      ),
    ),
  },
  nir1_pack_context: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.nir1PackContext, "nir1PackContext")(
          requireNir1PackingRequest(a),
        ),
      ),
  },
  nir1_entity_relation_revision_create: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNir1EntityRelationRevisionCreateRequest(a);
      return parseWire(
        await requireNapiMethod(
          b,
          b.nir1EntityRelationRevisionCreate,
          "nir1EntityRelationRevisionCreate",
        )(payload, workspaceBinding),
      );
    },
  },
  narrative_scene_scope_read: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeSceneScopeRead,
          "narrativeSceneScopeRead",
        )(requireSceneScopeReadRequest(a)),
      ),
  },
  narrative_scene_scope_update: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeSceneScopeUpdate,
          "narrativeSceneScopeUpdate",
        )(requireSceneScopeMutationRequest(a, "narrative_scene_scope_update")),
      ),
  },
  narrative_scene_scope_registry_update: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeSceneScopeRegistryUpdate,
          "narrativeSceneScopeRegistryUpdate",
        )(
          requireSceneScopeMutationRequest(
            a,
            "narrative_scene_scope_registry_update",
          ),
        ),
      ),
  },
  // The typed Revision reader returns Evidence plaintext and therefore stays
  // out of renderer IPC until the Native-owned D2a publication gate exists.
  semantic_reranker_shadow_score: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticRerankerShadowScore,
          "semanticRerankerShadowScore",
        )(requireSemanticRerankerShadowRequest(a)),
      ),
  },
  codex_index_entry: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.codexIndexEntry, "codexIndexEntry")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "codex_index_entry",
          ),
          requireNonEmptyString(a, "projectId", "codex_index_entry"),
          requireString(a, "entryId", "codex_index_entry"),
        ),
      ),
  },
  codex_semantic_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexSemanticSearch,
          "codexSemanticSearch",
        )(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "codex_semantic_search",
          ),
          requireString(a, "projectId", "codex_semantic_search"),
          requireString(a, "query", "codex_semantic_search"),
          requireUnsignedInteger(a, "limit", "codex_semantic_search"),
        ),
      ),
  },
  codex_index_status: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexIndexStatus,
          "codexIndexStatus",
        )(requireString(a, "projectId", "codex_index_status")),
      ),
  },
  codex_reindex_all: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexReindexAll,
          "codexReindexAll",
        )(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "codex_reindex_all",
          ),
          requireString(a, "projectId", "codex_reindex_all"),
        ),
      ),
  },
  events_index_entry: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.eventsIndexEntry, "eventsIndexEntry")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "events_index_entry",
          ),
          requireNonEmptyString(a, "projectId", "events_index_entry"),
          requireString(a, "eventId", "events_index_entry"),
        ),
      ),
  },
  events_semantic_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventsSemanticSearch,
          "eventsSemanticSearch",
        )(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "events_semantic_search",
          ),
          requireString(a, "projectId", "events_semantic_search"),
          requireString(a, "query", "events_semantic_search"),
          requireUnsignedInteger(a, "limit", "events_semantic_search"),
        ),
      ),
  },
  events_index_status: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventsIndexStatus,
          "eventsIndexStatus",
        )(requireString(a, "projectId", "events_index_status")),
      ),
  },
  events_reindex_all: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventsReindexAll,
          "eventsReindexAll",
        )(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "events_reindex_all",
          ),
          requireString(a, "projectId", "events_reindex_all"),
        ),
      ),
  },
  chat_index_message: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.chatIndexMessage, "chatIndexMessage")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "chat_index_message",
          ),
          requireNonEmptyString(a, "projectId", "chat_index_message"),
          requireString(a, "messageId", "chat_index_message"),
        ),
      ),
  },
  chat_message_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.chatMessageSearch, "chatMessageSearch")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "chat_message_search",
          ),
          requireString(a, "projectId", "chat_message_search"),
          requireString(a, "query", "chat_message_search"),
          requireUnsignedInteger(a, "limit", "chat_message_search"),
        ),
      ),
  },
  chat_index_status: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.chatIndexStatus,
          "chatIndexStatus",
        )(requireString(a, "projectId", "chat_index_status")),
      ),
  },
  chat_reindex_all: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.chatReindexAll,
          "chatReindexAll",
        )(
          requireNonEmptyString(a, "expectedWorkspacePath", "chat_reindex_all"),
          requireString(a, "projectId", "chat_reindex_all"),
        ),
      ),
  },
  semantic_index_status: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticIndexStatus,
          "semanticIndexStatus",
        )(requireString(a, "projectId", "semantic_index_status")),
      ),
  },
  semantic_reindex_all: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.semanticReindexAll, "semanticReindexAll")(
          requireNonEmptyString(
            a,
            "expectedWorkspacePath",
            "semantic_reindex_all",
          ),
          requireString(a, "projectId", "semantic_reindex_all"),
          optionalOpaqueRunId(a, "runId", "semantic_reindex_all"),
        ),
      ),
  },
  semantic_chunk_context: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticChunkContext,
          "semanticChunkContext",
        )(
          requireString(a, "sceneId", "semantic_chunk_context"),
          requireUnsignedInteger(a, "charStart", "semantic_chunk_context"),
          requireUnsignedInteger(a, "charEnd", "semantic_chunk_context"),
          requireUnsignedInteger(a, "padding", "semantic_chunk_context"),
        ),
      ),
  },
  semantic_debug_dump: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.semanticDebugDump, "semanticDebugDump")(
          requireString(a, "projectId", "semantic_debug_dump"),
          optionalString(a, "sceneId", "semantic_debug_dump"),
          optionalUnsignedInteger(a, "limit", "semantic_debug_dump"),
        ),
      ),
  },
  // plot_threads 8 コマンド（Phase 3 バッチ1 — grimodex-db::plot_threads を
  // Tauri と共用）。Tauri 側 fn 署名（src-tauri/src/commands/plot_threads.rs）:
  //   create(payload) / update(id, patch) / delete(id) / list(project_id) /
  //   link_create(payload) / link_update(id, patch) / link_delete(id) /
  //   list_links(project_id)。payload / patch は camelCase オブジェクトを素通し
  //   （from_wire が serde rename_all で受ける）。返り値は生の SQLite 行。
  plot_thread_create: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadCreate(
          requirePlotCreatePayload(a, "plot_thread_create"),
        ),
      ),
  },
  plot_thread_update: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadUpdate(
          requireString(a, "id", "plot_thread_update"),
          requirePlotVersionedPatch(a, "plot_thread_update"),
        ),
      ),
  },
  plot_thread_delete: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadDelete(
          requirePlotDeletePayload(a, "plot_thread_delete"),
        ),
      ),
  },
  plot_thread_list: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadList(
          requireString(a, "projectId", "plot_thread_list"),
        ),
      ),
  },
  plot_thread_link_create: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadLinkCreate(
          requirePlotCreatePayload(a, "plot_thread_link_create"),
        ),
      ),
  },
  plot_thread_branch_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadBranchCreate,
          "plotThreadBranchCreate",
        )(requirePlotThreadBranchCreatePayload(a)),
      ),
  },
  plot_thread_branch_update: {
    run: async (b, a) => {
      const id = requireString(a, "id", "plot_thread_branch_update");
      const patch = requirePlotVersionedPatch(a, "plot_thread_branch_update");
      return parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadBranchUpdate,
          "plotThreadBranchUpdate",
        )(id, patch),
      );
    },
  },
  plot_thread_branch_delete: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadBranchDelete,
          "plotThreadBranchDelete",
        )(requirePlotDeletePayload(a, "plot_thread_branch_delete")),
      ),
  },
  plot_thread_move_marker_bundle: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadMoveMarkerBundle,
          "plotThreadMoveMarkerBundle",
        )(requirePlotThreadMoveMarkerBundlePayload(a)),
      ),
  },
  plot_thread_restore_snapshot: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadRestoreSnapshot,
          "plotThreadRestoreSnapshot",
        )(requirePlotThreadRestoreSnapshotPayload(a)),
      ),
  },
  plot_thread_delete_snapshot: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.plotThreadDeleteSnapshot,
          "plotThreadDeleteSnapshot",
        )(requirePlotThreadDeleteSnapshotPayload(a)),
      ),
  },
  plot_thread_link_update: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadLinkUpdate(
          requireString(a, "id", "plot_thread_link_update"),
          requirePlotVersionedPatch(a, "plot_thread_link_update"),
        ),
      ),
  },
  plot_thread_link_delete: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadLinkDelete(
          requirePlotDeletePayload(a, "plot_thread_link_delete"),
        ),
      ),
  },
  plot_thread_list_links: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadListLinks(
          requireString(a, "projectId", "plot_thread_list_links"),
        ),
      ),
  },
  // foreshadow 20 コマンド（Phase 3 バッチ1 — grimodex-db::foreshadow を Tauri と
  // 共用。到達不能だった旧 foreshadow_list は両ランタイムから撤去済み）。
  // payload / patch / setups / payoffs は camelCase を素通し（from_wire が
  // serde rename_all + normalize_integer_numbers で受ける）。Value/応答 struct は
  // parse して返す。unit 返りは null。
  foreshadow_create: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowCreate(
          requireForeshadowPayload(a, "foreshadow_create"),
        ),
      ),
  },
  foreshadow_update: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowUpdate(
          requireString(a, "id", "foreshadow_update"),
          requireForeshadowVersionedPatch(a, "foreshadow_update"),
        ),
      ),
  },
  foreshadow_delete: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowDelete(
          requireForeshadowDeletePayload(a, "foreshadow_delete"),
        ),
      ),
  },
  foreshadow_list_with_labels: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowListWithLabels(
          requireString(a, "projectId", "foreshadow_list_with_labels"),
        ),
      ),
  },
  foreshadow_list_open_for_context: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowListOpenForContext(
          requireString(a, "projectId", "foreshadow_list_open_for_context"),
        ),
      ),
  },
  foreshadow_get_scene_info: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGetSceneInfo(
          requireString(a, "sceneId", "foreshadow_get_scene_info"),
        ),
      ),
  },
  foreshadow_get_scene_context: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGetSceneContext(
          requireString(a, "sceneId", "foreshadow_get_scene_context"),
        ),
      ),
  },
  foreshadow_list_by_codex_entry: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowListByCodexEntry(
          requireString(a, "codexEntryId", "foreshadow_list_by_codex_entry"),
        ),
      ),
  },
  foreshadow_get_chapter_stats: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGetChapterStats(
          requireString(a, "chapterId", "foreshadow_get_chapter_stats"),
        ),
      ),
  },
  foreshadow_get_setup: {
    // Option<Value> — null 許容（parseWire("null") = null）。
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGetSetup(
          requireString(a, "setupId", "foreshadow_get_setup"),
        ),
      ),
  },
  foreshadow_update_setup: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowUpdateSetup(
          requireString(a, "id", "foreshadow_update_setup"),
          requireForeshadowVersionedPatch(a, "foreshadow_update_setup"),
        ),
      ),
  },
  foreshadow_get: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGet(requireString(a, "id", "foreshadow_get")),
      ),
  },
  foreshadow_link_codex: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowLinkCodex(
          requireForeshadowAssociationPayload(a, "foreshadow_link_codex"),
        ),
      ),
  },
  foreshadow_unlink_codex: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowUnlinkCodex(
          requireForeshadowAssociationPayload(a, "foreshadow_unlink_codex"),
        ),
      ),
  },
  foreshadow_list_linked_codex: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowListLinkedCodex(
          requireString(a, "foreshadowId", "foreshadow_list_linked_codex"),
        ),
      ),
  },
  foreshadow_set_setup_strength: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowSetSetupStrength(
          requireForeshadowSetupStrengthPayload(
            a,
            "foreshadow_set_setup_strength",
          ),
        ),
      ),
  },
  foreshadow_setup_create_ai: {
    // FE は 12 個の flat な camelCase キーを送る（payload ラップ無し）。args
    // オブジェクトをそのまま渡し、napi 側 from_wire が SetupCreateAiInput に落とす。
    run: async (b, a) => {
      requireForeshadowBaseVersion(a, "foreshadow_setup_create_ai");
      requireForeshadowMutationIdentity(a, "foreshadow_setup_create_ai");
      requireForeshadowRendererAuthority(a, "foreshadow_setup_create_ai", [
        "human-direct",
        "interactive-agent-command",
      ]);
      return parseWire(await b.foreshadowSetupCreateAi(a));
    },
  },
  foreshadow_resolve_orphan: {
    // Option<String> — reinsert 時のみ new_id、その他 null（parseWire で復元）。
    run: async (b, a) => {
      const payload = requireRecord(a, "payload", "foreshadow_resolve_orphan");
      requireForeshadowBaseVersion(payload, "foreshadow_resolve_orphan");
      requireForeshadowMutationIdentity(payload, "foreshadow_resolve_orphan");
      requireForeshadowRendererAuthority(payload, "foreshadow_resolve_orphan", [
        "human-direct",
      ]);
      return parseWire(await b.foreshadowResolveOrphan(payload));
    },
  },
  foreshadow_save_anchors_for_scene: {
    run: async (b, a) => {
      const payload = requireForeshadowPayload(
        a,
        "foreshadow_save_anchors_for_scene",
      );
      requireForeshadowAnchorPayloads(
        payload,
        "foreshadow_save_anchors_for_scene",
      );
      requireString(payload, "sceneId", "foreshadow_save_anchors_for_scene");
      requireNumber(
        payload,
        "docContentSize",
        "foreshadow_save_anchors_for_scene",
      );
      return parseWire(await b.foreshadowSaveAnchorsForScene(payload));
    },
  },
  foreshadow_load_anchors_for_scene: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowLoadAnchorsForScene(
          requireString(a, "sceneId", "foreshadow_load_anchors_for_scene"),
        ),
      ),
  },
  // agent_writes 19 コマンド（Phase 3 バッチ1 — shared grimodex-db を Tauri と
  // 共用）。すべて FE は単一の `{ payload }` を送り、AgentWriteResult /
  // ProseStageResult (camelCase) が返る。payload はそのまま素通し（napi 側 from_wire
  // が serde rename_all + normalize_integer_numbers で受ける）。
  agent_codex_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexCreate(
          requireCanonicalWriterIdentity(a, "agent_codex_create", [
            "interactive-agent-command",
          ]),
        ),
      ),
  },
  agent_codex_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexUpdate(
          requireCanonicalWriterIdentity(a, "agent_codex_update", [
            "interactive-agent-command",
          ]),
        ),
      ),
  },
  agent_codex_delete: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexDelete(
          requireCanonicalWriterIdentity(a, "agent_codex_delete", [
            "interactive-agent-command",
          ]),
        ),
      ),
  },
  codex_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexCreate,
          "codexCreate",
        )(
          requireCanonicalWriterIdentity(a, "codex_create", [
            "human-direct",
            "import-apply",
            "history-replay",
            "restore-or-migration",
          ]),
        ),
      ),
  },
  codex_update: {
    run: async (b, a) => {
      const payload = requireCanonicalWriterIdentity(a, "codex_update", [
        "human-direct",
        "import-apply",
        "history-replay",
        "restore-or-migration",
      ]);
      requireTimelapseDocStepCoverage(payload, "codex_update");
      return parseWire(
        await requireNapiMethod(b, b.codexUpdate, "codexUpdate")(payload),
      );
    },
  },
  codex_delete: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexDelete,
          "codexDelete",
        )(
          requireCanonicalWriterIdentity(a, "codex_delete", [
            "human-direct",
            "import-apply",
            "history-replay",
            "restore-or-migration",
          ]),
        ),
      ),
  },
  agent_codex_mutate: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexMutate(
          requireCanonicalWriterIdentity(a, "agent_codex_mutate", [
            "interactive-agent-command",
          ]),
        ),
      ),
  },
  codex_mutate: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexMutate,
          "codexMutate",
        )(
          requireCanonicalWriterIdentity(
            a,
            "codex_mutate",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_write_bundle: {
    run: async (b, a) =>
      parseWire(
        await b.agentWriteBundle(
          requirePresent(a, "payload", "agent_write_bundle"),
        ),
      ),
  },
  agent_snippet_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentSnippetCreate(
          requireCanonicalAgentCreatePayload(a, "agent_snippet_create"),
        ),
      ),
  },
  snippet_create: {
    run: async (b, a) =>
      parseWire(
        await b.snippetCreate(requireSnippetWriterPayload(a, "snippet_create")),
      ),
  },
  snippet_update: {
    run: async (b, a) =>
      parseWire(
        await b.snippetUpdate(requireSnippetWriterPayload(a, "snippet_update")),
      ),
  },
  snippet_delete: {
    run: async (b, a) =>
      parseWire(
        await b.snippetDelete(requireSnippetWriterPayload(a, "snippet_delete")),
      ),
  },
  agent_propose_scene_body: {
    run: async (b, a) =>
      parseWire(
        await b.agentProposeSceneBody(
          requirePresent(a, "payload", "agent_propose_scene_body"),
        ),
      ),
  },
  agent_accept_prose_stage: {
    run: async (b, a) =>
      parseWire(
        await b.agentAcceptProseStage(
          requirePresent(a, "payload", "agent_accept_prose_stage"),
        ),
      ),
  },
  agent_discard_prose_stage: {
    run: async (b, a) =>
      parseWire(
        await b.agentDiscardProseStage(
          requirePresent(a, "payload", "agent_discard_prose_stage"),
        ),
      ),
  },
  agent_apply_undo_journal: {
    run: async (b, a) =>
      parseWire(await b.agentApplyUndoJournal(requireUndoJournalPayload(a))),
  },
  agent_foreshadow_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentForeshadowCreate(requireAgentForeshadowCreatePayload(a)),
      ),
  },
  agent_foreshadow_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentForeshadowUpdate(requireAgentForeshadowUpdatePayload(a)),
      ),
  },
  agent_event_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventCreate(
          requireAgentChroniclePayload(a, "agent_event_create"),
        ),
      ),
  },
  event_create: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventCreate,
          "eventCreate",
        )(
          requireAgentChroniclePayload(
            a,
            "event_create",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_event_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventUpdate(
          requireEventMutationPayload(a, "agent_event_update"),
        ),
      ),
  },
  event_update: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventUpdate,
          "eventUpdate",
        )(
          requireEventMutationPayload(
            a,
            "event_update",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_event_delete: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventDelete(
          requireEventMutationPayload(a, "agent_event_delete"),
        ),
      ),
  },
  event_delete: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventDelete,
          "eventDelete",
        )(
          requireEventMutationPayload(
            a,
            "event_delete",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_chronicle_bulk_mutate: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.agentChronicleBulkMutate,
          "agentChronicleBulkMutate",
        )(requireChronicleBulkPayload(a)),
      ),
  },
  chronicle_bulk_mutate: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.chronicleBulkMutate,
          "chronicleBulkMutate",
        )(
          requireChronicleBulkPayload(
            a,
            "chronicle_bulk_mutate",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_event_set_participants: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventSetParticipants(
          requireEventMutationPayload(a, "agent_event_set_participants"),
        ),
      ),
  },
  event_participants_set: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventParticipantsSet,
          "eventParticipantsSet",
        )(
          requireEventMutationPayload(
            a,
            "event_participants_set",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_scene_event_link: {
    run: async (b, a) =>
      parseWire(
        await b.agentSceneEventLink(
          requireAgentChroniclePayload(a, "agent_scene_event_link"),
        ),
      ),
  },
  scene_event_link: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.sceneEventLink,
          "sceneEventLink",
        )(
          requireAgentChroniclePayload(
            a,
            "scene_event_link",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_scene_event_link_batch: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.agentSceneEventLinkBatch,
          "agentSceneEventLinkBatch",
        )(requireSceneEventLinkBatchPayload(a)),
      ),
  },
  scene_event_link_batch: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.sceneEventLinkBatch,
          "sceneEventLinkBatch",
        )(
          requireSceneEventLinkBatchPayload(
            a,
            "scene_event_link_batch",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_scene_event_unlink: {
    run: async (b, a) =>
      parseWire(
        await b.agentSceneEventUnlink(
          requireAgentChroniclePayload(a, "agent_scene_event_unlink"),
        ),
      ),
  },
  scene_event_unlink: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.sceneEventUnlink,
          "sceneEventUnlink",
        )(
          requireAgentChroniclePayload(
            a,
            "scene_event_unlink",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_event_relation_add: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventRelationAdd(
          requireAgentChroniclePayload(a, "agent_event_relation_add"),
        ),
      ),
  },
  event_relation_add: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventRelationAdd,
          "eventRelationAdd",
        )(
          requireAgentChroniclePayload(
            a,
            "event_relation_add",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  agent_event_relation_remove: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventRelationRemove(
          requireAgentChroniclePayload(a, "agent_event_relation_remove"),
        ),
      ),
  },
  event_relation_remove: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventRelationRemove,
          "eventRelationRemove",
        )(
          requireAgentChroniclePayload(
            a,
            "event_relation_remove",
            RENDERER_CHRONICLE_AUTHORITY_ROUTES,
          ),
        ),
      ),
  },
  narrative_extraction_capture_workspace_binding: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeExtractionCaptureWorkspaceBinding,
          "narrativeExtractionCaptureWorkspaceBinding",
        )(requireNarrativeExtractionCaptureWorkspacePath(a)),
      ),
  },
  narrative_extraction_create_run: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_create_run",
        );
      return parseWire(
        await b.narrativeExtractionCreateRun(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_get_run: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionGetRun(
          requirePresent(a, "payload", "narrative_extraction_get_run"),
        ),
      ),
  },
  narrative_extraction_list_resumable_runs: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionListResumableRuns(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_list_resumable_runs",
          ),
        ),
      ),
  },
  narrative_extraction_is_run_resumable_for_review: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeExtractionIsRunResumableForReview,
          "narrativeExtractionIsRunResumableForReview",
        )(requireReviewResumabilityPayload(a)),
      ),
  },
  narrative_extraction_list_chronicle_task_resume_candidates: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeExtractionListChronicleTaskResumeCandidates,
          "narrativeExtractionListChronicleTaskResumeCandidates",
        )(requireChronicleTaskResumeCandidatesPayload(a)),
      ),
  },
  narrative_extraction_cancel_run: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_cancel_run",
        );
      return parseWire(
        await b.narrativeExtractionCancelRun(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_claim_task: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_claim_task",
        );
      return parseWire(
        await b.narrativeExtractionClaimTask(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_finish_task: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_finish_task",
        );
      return parseWire(
        await b.narrativeExtractionFinishTask(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_fail_task: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_fail_task",
        );
      return parseWire(
        await b.narrativeExtractionFailTask(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_save_proposal_set: {
    run: async (b, a) => {
      const [payload, workspaceBinding] =
        requireNarrativeExtractionBoundMutation(
          a,
          "narrative_extraction_save_proposal_set",
        );
      return parseWire(
        await b.narrativeExtractionSaveProposalSet(payload, workspaceBinding),
      );
    },
  },
  narrative_extraction_create_human_derived_revision: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeExtractionCreateHumanDerivedRevision,
          "narrativeExtractionCreateHumanDerivedRevision",
        )(
          requireRecord(
            a,
            "payload",
            "narrative_extraction_create_human_derived_revision",
          ),
        ),
      ),
  },
  narrative_extraction_get_run_review_bundle: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionGetRunReviewBundle(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_get_run_review_bundle",
          ),
        ),
      ),
  },
  narrative_extraction_append_revision: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionAppendRevision(
          requirePresent(a, "payload", "narrative_extraction_append_revision"),
        ),
      ),
  },
  narrative_extraction_append_decision: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionAppendDecision(
          requirePresent(a, "payload", "narrative_extraction_append_decision"),
        ),
      ),
  },
  narrative_extraction_append_human_decision: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionAppendHumanDecision(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_append_human_decision",
          ),
        ),
      ),
  },
  narrative_extraction_revise_and_decide: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionReviseAndDecide(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_revise_and_decide",
          ),
        ),
      ),
  },
  narrative_extraction_revise_and_decide_as_human: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionReviseAndDecideAsHuman(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_revise_and_decide_as_human",
          ),
        ),
      ),
  },
  narrative_extraction_set_human_field_lock: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionSetHumanFieldLock(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_set_human_field_lock",
          ),
        ),
      ),
  },
  narrative_extraction_prepare_commit: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionPrepareCommit(
          requirePresent(a, "payload", "narrative_extraction_prepare_commit"),
        ),
      ),
  },
  narrative_extraction_apply_commit: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionApplyCommit(
          requirePresent(a, "payload", "narrative_extraction_apply_commit"),
        ),
      ),
  },
  narrative_extraction_get_commit_status: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionGetCommitStatus(
          requirePresent(
            a,
            "payload",
            "narrative_extraction_get_commit_status",
          ),
        ),
      ),
  },
  narrative_extraction_undo_commit: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionUndoCommit(
          requireNarrativeCommitReplayPayload(
            a,
            "narrative_extraction_undo_commit",
          ),
        ),
      ),
  },
  narrative_extraction_redo_commit: {
    run: async (b, a) =>
      parseWire(
        await b.narrativeExtractionRedoCommit(
          requireNarrativeCommitReplayPayload(
            a,
            "narrative_extraction_redo_commit",
          ),
        ),
      ),
  },
  // Gate C2-T1: Attention typed writer / Maintenance Inbox read model
  narrative_maintenance_attention_set: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeMaintenanceAttentionSet,
          "narrativeMaintenanceAttentionSet",
        )(requireNarrativeMaintenanceAttentionSetPayload(a)),
      ),
  },
  narrative_maintenance_attention_clear: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeMaintenanceAttentionClear,
          "narrativeMaintenanceAttentionClear",
        )(requireNarrativeMaintenanceAttentionClearPayload(a)),
      ),
  },
  narrative_maintenance_inbox_list: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.narrativeMaintenanceInboxList,
          "narrativeMaintenanceInboxList",
        )(requireNarrativeMaintenanceInboxListPayload(a)),
      ),
  },
  // Gate C2 Run Kind Policy: the five named operations replacing the old
  // two-value rebuildNarrativeDependencyIndex(mode: verify|repair)
  // (policies/narrative/narrative-run-kind-policy.json's apiSplit).
  verify_narrative_dependency_graph: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.verifyNarrativeDependencyGraph,
          "verifyNarrativeDependencyGraph",
        )(requireVerifyNarrativeDependencyGraphPayload(a)),
      ),
  },
  rebuild_narrative_derived_state: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.rebuildNarrativeDerivedState,
          "rebuildNarrativeDerivedState",
        )(requireRebuildNarrativeDerivedStatePayload(a)),
      ),
  },
  get_narrative_backfill_status: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.getNarrativeBackfillStatus,
          "getNarrativeBackfillStatus",
        )(requireGetNarrativeBackfillStatusPayload(a)),
      ),
  },
  retry_narrative_legacy_backfill: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.retryNarrativeLegacyBackfill,
          "retryNarrativeLegacyBackfill",
        )(requireRetryNarrativeLegacyBackfillPayload(a)),
      ),
  },
  repair_narrative_dependency_declarations: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.repairNarrativeDependencyDeclarations,
          "repairNarrativeDependencyDeclarations",
        )(requireRepairNarrativeDependencyDeclarationsPayload(a)),
      ),
  },
  // post_effect pure-db 7 コマンド（Phase 3 バッチ1）。effectType / status は
  // Option<String>（文字列以外は None）、limit / offset は Option<i64>。
  // reply_to_annotation は snake_case の `args` を素通し。
  list_post_effect_runs: {
    run: async (b, a) =>
      parseWire(
        await b.listPostEffectRuns(
          requireString(a, "projectId", "list_post_effect_runs"),
          optionalString(a, "effectType", "list_post_effect_runs"),
          optionalNumber(a, "limit", "list_post_effect_runs"),
          optionalNumber(a, "offset", "list_post_effect_runs"),
        ),
      ),
  },
  list_scene_lens_for_project: {
    run: async (b, a) =>
      parseWire(
        await b.listSceneLensForProject(
          requireString(a, "projectId", "list_scene_lens_for_project"),
        ),
      ),
  },
  list_annotations_for_scene: {
    run: async (b, a) =>
      parseWire(
        await b.listAnnotationsForScene(
          requireString(a, "projectId", "list_annotations_for_scene"),
          requireString(a, "sceneId", "list_annotations_for_scene"),
          optionalString(a, "status", "list_annotations_for_scene"),
        ),
      ),
  },
  list_annotations_for_project: {
    run: async (b, a) =>
      parseWire(
        await b.listAnnotationsForProject(
          requireString(a, "projectId", "list_annotations_for_project"),
          optionalString(a, "status", "list_annotations_for_project"),
        ),
      ),
  },
  update_annotation_status: {
    run: async (b, a) =>
      parseWire(
        await b.updateAnnotationStatus(
          requireString(a, "annotationId", "update_annotation_status"),
          requireString(a, "status", "update_annotation_status"),
          requireString(a, "projectId", "update_annotation_status"),
        ),
      ),
  },
  reply_to_annotation: {
    // FE は snake_case キーを `args` にネストして送る（ReplyToAnnotationArgs は
    // rename_all 無し）。Nativeのread-back rowは本文を含むため、返り値は
    // opaqueな生成済みIDだけに絞る。
    run: async (b, a) =>
      parseOpaqueReplyToAnnotation(
        await b.replyToAnnotation(
          requirePresent(a, "args", "reply_to_annotation"),
        ),
      ),
  },
  save_post_effect_annotations: {
    // unit 返り（annotations は raw snake_case 配列を素通し）
    run: async (b, a) => {
      await b.savePostEffectAnnotations(
        requireString(a, "projectId", "save_post_effect_annotations"),
        requireString(a, "sceneId", "save_post_effect_annotations"),
        requirePresent(a, "annotations", "save_post_effect_annotations"),
      );
      return null;
    },
  },
  // license（Phase 3e）。状態機械/Polar通信/license.jsonは共有Rust backendが
  // 一括して扱い、rendererへはキーを含まないDTOだけを返す。
  get_license_state: {
    run: async (b) =>
      parseWire(
        await requireNapiMethod(b, b.getLicenseState, "getLicenseState")(),
      ),
  },
  activate_license: {
    run: async (b, a, d) => {
      const state = parseWire(
        await requireNapiMethod(
          b,
          b.activateLicense,
          "activateLicense",
        )(requireString(a, "key", "activate_license")),
      );
      broadcastBestEffort(d, "license:state_changed", state);
      return state;
    },
  },
  revalidate_license: {
    run: async (b, _a, d) => {
      try {
        const state = parseWire(
          await requireNapiMethod(
            b,
            b.revalidateLicense,
            "revalidateLicense",
          )(),
        );
        broadcastBestEffort(d, "license:state_changed", state);
        return state;
      } catch (error) {
        await broadcastCurrentLicenseStateBestEffort(b, d);
        throw error;
      }
    },
  },
  deactivate_license: {
    run: async (b, _a, d) => {
      const state = parseWire(
        await requireNapiMethod(b, b.deactivateLicense, "deactivateLicense")(),
      );
      broadcastBestEffort(d, "license:state_changed", state);
      return state;
    },
  },
  // post_effect run 系（Phase 3d）。FE の `{ args: snake_case DTO }` は nested
  // object のキーを一切変換せず native へ渡す。start は run_id を即返す
  // fire-and-forgetで、進捗/終端は既存 post_effect:* event 経路が担う。
  start_post_effect_run: {
    run: async (b, a, d) => {
      const args = requireRecord(a, "args", "start_post_effect_run");
      const expectedWorkspacePath = requireNonEmptyString(
        a,
        "expectedWorkspacePath",
        "start_post_effect_run",
      );
      if (args.effect_type === "impact_review") {
        throw new Error(
          "invalid args `effect_type` for command `start_post_effect_run`: impact_review requires start_post_effect_run_multi with source_guard",
        );
      }
      const startPostEffectRun = requireNapiMethod(
        b,
        b.startPostEffectRun,
        "startPostEffectRun",
      );
      const { settings, apiKey, apiKeyError } =
        await resolvePostEffectAiSnapshot(b, args, d, "start_post_effect_run");
      const callerIdentity = a.callerIdentity;
      return parseWire(
        await startPostEffectRun(
          callerIdentity === undefined
            ? { ...args, expectedWorkspacePath }
            : { ...args, expectedWorkspacePath, callerIdentity },
          settings,
          apiKey,
          apiKeyError,
        ),
      );
    },
  },
  start_post_effect_run_multi: {
    run: async (b, a, d) => {
      const args = requireRecord(a, "args", "start_post_effect_run_multi");
      const expectedWorkspacePath = requireNonEmptyString(
        a,
        "expectedWorkspacePath",
        "start_post_effect_run_multi",
      );
      validateOptionalSqliteSourceGuard(args, "start_post_effect_run_multi");
      const startPostEffectRunMulti = requireNapiMethod(
        b,
        b.startPostEffectRunMulti,
        "startPostEffectRunMulti",
      );
      const { settings, apiKey, apiKeyError } =
        await resolvePostEffectAiSnapshot(
          b,
          args,
          d,
          "start_post_effect_run_multi",
        );
      const callerIdentity = a.callerIdentity;
      return parseWire(
        await startPostEffectRunMulti(
          callerIdentity === undefined
            ? { ...args, expectedWorkspacePath }
            : { ...args, expectedWorkspacePath, callerIdentity },
          settings,
          apiKey,
          apiKeyError,
        ),
      );
    },
  },
  abort_post_effect_run: {
    run: async (b, a) => {
      const runId = requireString(a, "runId", "abort_post_effect_run");
      const projectId = requireString(a, "projectId", "abort_post_effect_run");
      await requireNapiMethod(
        b,
        b.abortPostEffectRun,
        "abortPostEffectRun",
      )(runId, projectId);
      return null;
    },
  },
  // AI チャット（Phase 3 バッチ3a）。send 系は napi に api キーを持たせない設計:
  // dispatch が getAiSettings で設定を読み、secrets(safeStorage) で実効キーを解決し、
  // 同じ settings スナップショットを第2引数、平文キーを第3引数で注入する。
  // args(camelCase 一式)は napi 側 ChatRequest が deserialize する（未知キーは無視）。
  // 返り値は Tauri と同形（ChatResponse / unit）。
  get_ai_settings: {
    run: async (b) => parseWire(await b.getAiSettings()),
  },
  send_chat_message: {
    run: async (b, a, d) => {
      optionalString(a, "expectedOllamaEndpoint", "send_chat_message");
      validateOptionalPositiveU32(
        a,
        "requestMaxOutputTokens",
        "send_chat_message",
      );
      requireNativeAiAuditContext(a, "send_chat_message");
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_chat_message",
        true,
      );
      return parseWire(await b.sendChatMessage(a, settings, apiKey));
    },
  },
  send_chat_message_stream: {
    // fire-and-forget ストリーム。チャンク/完了/エラーは chat:stream-* イベント経由。
    // Tauri 同様、全ストリーム完了後に resolve（FE は SLOW_COMMANDS で 300s 許容）。
    run: async (b, a, d) => {
      optionalString(a, "expectedOllamaEndpoint", "send_chat_message_stream");
      validateOptionalPositiveU32(
        a,
        "requestMaxOutputTokens",
        "send_chat_message_stream",
      );
      requireNativeAiStreamCorrelation(a, "send_chat_message_stream");
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_chat_message_stream",
        true,
      );
      await b.sendChatMessageStream(a, settings, apiKey);
      return null;
    },
  },
  abort_chat_stream: {
    run: async (b, a) => {
      const streamId = requireStreamId(a, "abort_chat_stream");
      const transportTerminationObserved = await b.abortChatStream(streamId);
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved,
      };
    },
  },
  // AI Phase 3b。inline/agent/test は必須キー規則、models だけoptional lookup。
  save_ai_settings: {
    run: async (b, a) => {
      await requireNapiMethod(
        b,
        b.saveAiSettings,
        "saveAiSettings",
      )(requirePresent(a, "settings", "save_ai_settings"));
      return null;
    },
  },
  send_inline_ai_stream: {
    run: async (b, a, d) => {
      requirePresent(a, "messages", "send_inline_ai_stream");
      requireNativeAiStreamCorrelation(a, "send_inline_ai_stream");
      const sendInlineAiStream = requireNapiMethod(
        b,
        b.sendInlineAiStream,
        "sendInlineAiStream",
      );
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_inline_ai_stream",
      );
      await sendInlineAiStream(a, settings, apiKey);
      return null;
    },
  },
  abort_inline_ai_stream: {
    run: async (b, a) => {
      const streamId = requireStreamId(a, "abort_inline_ai_stream");
      const transportTerminationObserved = await requireNapiMethod(
        b,
        b.abortInlineAiStream,
        "abortInlineAiStream",
      )(streamId);
      return {
        abortCommandAcknowledged: true,
        transportTerminationObserved,
      };
    },
  },
  send_agent_message: {
    run: async (b, a, d) => {
      requirePresent(a, "messages", "send_agent_message");
      requirePresent(a, "tools", "send_agent_message");
      optionalString(a, "expectedOllamaEndpoint", "send_agent_message");
      validateOptionalPositiveU32(
        a,
        "requestMaxOutputTokens",
        "send_agent_message",
      );
      validateOptionalResolvedToolProtocol(
        a,
        "resolvedToolProtocol",
        "send_agent_message",
      );
      requireNativeAiAuditContext(a, "send_agent_message");
      const sendAgentMessage = requireNapiMethod(
        b,
        b.sendAgentMessage,
        "sendAgentMessage",
      );
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_agent_message",
      );
      const response = parseWire(await sendAgentMessage(a, settings, apiKey));
      return d.issueAgentAuthorityCapabilities
        ? d.issueAgentAuthorityCapabilities(a, response)
        : response;
    },
  },
  list_ai_models: {
    run: async (b, a, d) => {
      requireString(a, "provider", "list_ai_models");
      optionalString(a, "selectedModelId", "list_ai_models");
      optionalString(a, "expectedOllamaEndpoint", "list_ai_models");
      const listAiModels = requireNapiMethod(b, b.listAiModels, "listAiModels");
      const { settings, apiKey } = await resolveOptionalAiKeyAndSettings(
        b,
        a,
        d,
        "list_ai_models",
      );
      return parseWire(await listAiModels(a, settings, apiKey));
    },
  },
  test_ai_connection: {
    run: async (b, a, d) => {
      requireString(a, "provider", "test_ai_connection");
      requireString(a, "model", "test_ai_connection");
      requireNativeAiAuditContext(a, "test_ai_connection");
      const testAiConnection = requireNapiMethod(
        b,
        b.testAiConnection,
        "testAiConnection",
      );
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "test_ai_connection",
      );
      return testAiConnection(a, settings, apiKey);
    },
  },
};

/**
 * Tauri `post_effect.rs` で role provider/model override を適用する effect。
 * typo / intra / meta_structure は既定 AI settings を読む従来契約なので、DTO に
 * override が混入してもキーlookupへ持ち込まない（別providerのキー誤注入防止）。
 */
const POST_EFFECT_ROLE_OVERRIDE_TYPES: ReadonlySet<string> = new Set([
  "consistency",
  "review",
  "intent_drift",
  "pseudo_comment",
  "impact_review",
  "timeline_consistency",
]);

interface PostEffectAiSnapshot {
  settings: unknown;
  apiKey: string | null;
  apiKeyError: string | null;
}

/**
 * post-effect専用のAI設定/secret snapshot。
 *
 * start command はcache hitならHTTPを行わないため、キー未登録だけでなく
 * safeStorage破損/復号失敗もここではinvoke rejectにしない。lookup例外を文字列へ
 * 固定してnativeへ渡し、cache miss時の背景taskが post_effect:error とDB failedへ
 * 着地させる。これによりFEがrun_id確定前イベントをbufferする既存契約も保てる。
 */
async function resolvePostEffectAiSnapshot(
  backend: NapiBackendLike,
  args: CommandArgs,
  deps: DispatchDeps,
  cmd: string,
): Promise<PostEffectAiSnapshot> {
  if (!deps.secrets) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }
  const getApiKey = deps.secrets.getApiKeyForRequest;
  if (!getApiKey) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }

  // 設定read・キーroute解決・native呼出しは同一snapshotを共有（TOCTOU防止）。
  const settings = parseWire(await backend.getAiSettings());
  const usesRoleOverride =
    typeof args.effect_type === "string" &&
    POST_EFFECT_ROLE_OVERRIDE_TYPES.has(args.effect_type);
  const provider = usesRoleOverride ? args.provider_override : undefined;
  const endpointId = usesRoleOverride ? args.endpoint_id_override : undefined;

  try {
    return {
      settings,
      apiKey:
        getApiKey.call(deps.secrets, settings, provider, endpointId) ?? null,
      apiKeyError: null,
    };
  } catch (error) {
    return {
      settings,
      apiKey: null,
      apiKeyError: toErrorString(error),
    };
  }
}

/**
 * チャット送信の設定スナップショット取得 + API キー解決。**設定は getAiSettings で
 * 1 回だけ読む**（返した `settings` を napi 送信へそのまま渡し、キー解決と送信を同一
 * スナップショットで行う — Tauri の単一 read_ai_settings と同じ原子性。2 度読みの
 * TOCTOU で「read#1 の provider のキーが read#2 の endpoint へ」流れる事故を防ぐ）。
 * secrets 不在は構成エラーとして明示。キー未設定時は resolveApiKeyForRequest が Tauri と
 * 同じ `No API key configured for <provider>` を throw する。
 */
async function resolveRequiredAiKeyAndSettings(
  backend: NapiBackendLike,
  args: CommandArgs,
  deps: DispatchDeps,
  cmd: string,
  validateEndpointOverride = false,
): Promise<{ settings: unknown; apiKey: string }> {
  if (!deps.secrets) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }
  const settings = parseWire(await backend.getAiSettings());
  if (validateEndpointOverride) {
    assertExplicitOpenaiCompatibleEndpointConfigured(settings, args, cmd);
  }
  const apiKey = deps.secrets.resolveApiKeyForRequest(
    settings,
    args.provider,
    args.endpointId,
  );
  return { settings, apiKey };
}

/**
 * The renderer seals an explicit OpenAI-compatible endpoint before begin and
 * dispatch. Re-check that identity against the same main-process settings
 * snapshot before resolving credentials or entering native code; otherwise a
 * deleted override would be silently retargeted to the active endpoint.
 * Non-compatible providers intentionally retain the legacy ignored-endpoint
 * behavior for older callers; the renderer rejects that contradiction.
 */
function assertExplicitOpenaiCompatibleEndpointConfigured(
  settings: unknown,
  args: CommandArgs,
  cmd: string,
): void {
  const requestedEndpointId = args.endpointId;
  if (
    typeof requestedEndpointId !== "string" ||
    requestedEndpointId.trim().length === 0
  ) {
    return;
  }
  const settingsRecord =
    typeof settings === "object" &&
    settings !== null &&
    !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  const requestedProvider =
    typeof args.provider === "string" && args.provider.trim().length > 0
      ? args.provider
      : settingsRecord.provider;
  if (requestedProvider !== "openai-compatible") return;

  const configuredEndpoints = settingsRecord.openaiCompatibleEndpoints;
  const endpointIsConfigured =
    Array.isArray(configuredEndpoints) && configuredEndpoints.length > 0
      ? configuredEndpoints.some(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            !Array.isArray(candidate) &&
            (candidate as Record<string, unknown>).id === requestedEndpointId,
        )
      : (() => {
          const legacy = settingsRecord.openaiCompatible;
          const legacyBaseUrl =
            typeof legacy === "object" &&
            legacy !== null &&
            !Array.isArray(legacy)
              ? (legacy as Record<string, unknown>).baseUrl
              : undefined;
          return (
            typeof legacyBaseUrl === "string" &&
            legacyBaseUrl.trim().length > 0 &&
            requestedEndpointId === "default"
          );
        })();
  if (!endpointIsConfigured) {
    throw new Error(
      `invalid args \`endpointId\` for command \`${cmd}\`: OpenAI-compatible endpoint is not configured`,
    );
  }
}

/** 旧 native binding を誤って組み合わせた場合も TypeError ではなく明示的に失敗させる。 */
function requireNapiMethod<T extends (...args: never[]) => unknown>(
  backend: NapiBackendLike,
  method: T | undefined,
  methodName: string,
): T {
  if (typeof method !== "function") {
    throw new Error(
      `${IPC_BACKEND_UNAVAILABLE_MARKER} native method ${methodName}`,
    );
  }
  return method.bind(backend) as T;
}

/** list_ai_models専用: 未登録キーだけを空文字へ畳み、破損/復号エラーは伝播。 */
async function resolveOptionalAiKeyAndSettings(
  backend: NapiBackendLike,
  args: CommandArgs,
  deps: DispatchDeps,
  cmd: string,
): Promise<{ settings: unknown; apiKey: string }> {
  if (!deps.secrets) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }
  const getApiKey = deps.secrets.getApiKeyForRequest;
  if (!getApiKey) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }
  const settings = parseWire(await backend.getAiSettings());
  const apiKey =
    getApiKey.call(deps.secrets, settings, args.provider, args.endpointId) ??
    "";
  return { settings, apiKey };
}

/**
 * lint_text の napi reason（LintError の {type,data} JSON 文字列）を
 * object reject へ復元する。JSON でない / 形が違う場合は元のエラーを
 * そのまま返す（引数検証エラー等は文字列ワイヤのまま）。
 */
function restoreLintWireError(e: unknown): unknown {
  const message = toErrorString(e);
  try {
    const parsed: unknown = JSON.parse(message);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "type" in parsed
    ) {
      return new WireErrorValue(parsed, message);
    }
  } catch {
    // JSON でなければ文字列ワイヤのまま
  }
  return e;
}

/**
 * main-TS 実装コマンドのハンドラ集合。実体は electron/main/shellCommands.ts
 * （窓ハンドルへの束縛が要るため ipc ルーターが invoke ごとに組み立てる）。
 */
export type ShellCommandHandlers = Readonly<
  Record<string, (args: CommandArgs) => Promise<unknown>>
>;

/**
 * main-TS 実装コマンド名（§4.3 の表 + Phase 3 追補の export / logs +
 * バッチ2 の external_mount）。external_mount 系は ipc ルーターが
 * ExternalMountManager から注入する（registry/watcher が invoke を跨いで
 * 持続するため per-invoke の buildShellCommandHandlers には含めない）。
 * 到達不能だった旧 external_mount_list は両ランタイムから撤去済み。
 */
export const SHELL_COMMAND_NAMES: readonly string[] = [
  "export_save_text",
  "export_save_bytes",
  "open_log_dir",
  "semantic_reranker_shadow_record",
  "external_mount_register",
  "external_mount_unregister",
  "external_mount_read_file",
  "external_mount_write_file",
  "external_mount_file_mtime",
  "external_mount_scan",
  // API キー保管（Phase 3 バッチ3a — safeStorage）。ipc ルーターが keyStore
  // (SecretsBridge) から extraShellHandlers として注入する（状態が invoke を跨いで
  // 持続するため per-invoke の buildShellCommandHandlers には含めない）。has は bool、
  // save/delete は unit。平文キーは save の引数としてのみ main へ渡り renderer に返さない。
  "has_api_key",
  "save_api_key",
  "delete_api_key",
  // CLI AI（Phase 3 バッチ3c）: main の常駐 child-process manager。napi backend
  // 不在時も利用でき、send/abort は同一 manager の active process を共有する。
  "detect_cli_binary",
  "test_cli_connection",
  "list_cli_models",
  "send_cli_chat_stream",
  "abort_cli_chat_stream",
  // Codex App Server high-level commands. Raw JSON-RPC methods/params never
  // cross this boundary; the manager validates ownership and read-only policy.
  "codex_app_get_status",
  "codex_app_test_connection",
  "codex_app_list_models",
  "codex_app_start_turn",
  "codex_app_interrupt_turn",
  "codex_app_update_history_revision",
  "codex_app_respond_to_request",
  "codex_app_archive_session_thread",
  "codex_app_set_thread_name",
  // Vivliostyle（Phase 3 バッチ5）: main常駐managerがbuild/preview child、
  // output token、native保存dialogをinvoke間で共有する。
  "vivliostyle_detect",
  "vivliostyle_build",
  "vivliostyle_abort_build",
  "vivliostyle_save_output",
  "vivliostyle_preview_start",
  "vivliostyle_preview_stop",
  // MCP（Phase 3 Batch 5）: mainがstandalone sidecarを解決し、workspaceは
  // native Backendから取得する。rendererへは実行可能pathとargsだけを返す。
  "get_mcp_config",
  // Electron updater（Phase 4）: main の単一 manager が check/download/install
  // state と electron-updater listener を invoke 間で共有する。
  "updater_check",
  "updater_download",
  "updater_install",
  // Mozkey IbG: official GitHub Release selection, checksum verification,
  // and native installer launch are owned by one stateful main manager.
  "mozkey_download_and_install",
];

// ─────────────────────────────────────────────────────────────────────────────
// invoke ディスパッチ（純関数 — ipc.ts はこれを ipcMain.handle に接続するだけ）
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchDeps {
  /** .node ロード失敗時は null（fail-soft: 明示エラー envelope を返す）。 */
  backend: NapiBackendLike | null;
  shell: ShellCommandHandlers;
  /**
   * API キー解決の窓口（safeStorage）。AI チャットコマンドが送信直前にキーを
   * 解決するために使う。未注入時、チャットコマンドは IPC_SECRETS_UNAVAILABLE で
   * 明示 reject する（他コマンドは影響なし）。
   */
  secrets?: SecretsResolver;
  /**
   * mainから全窓へ送るイベント窓口。manual license mutationの返却DTOを
   * 呼出元以外のZustand storeにも即時反映するために使う。
   */
  broadcast?: (channel: string, payload: unknown) => void;
  /** Main-owned, turn-scoped capabilities are issued only by Electron main. */
  issueAgentAuthorityCapabilities?: (
    args: CommandArgs,
    response: unknown,
  ) => Promise<unknown> | unknown;
}

/**
 * コマンド 1 件を実行して Envelope に畳む。**決して throw しない**（§5.2）。
 * 優先順位: napi コマンド表 → main-TS ハンドラ → IPC_UNIMPLEMENTED。
 * 移植済みcommandを古いshell stubが遮蔽しないよう、明示NAPI表を権威にする。
 */
export async function dispatchInvoke(
  cmd: string,
  args: CommandArgs,
  deps: DispatchDeps,
): Promise<Envelope> {
  try {
    if (Object.hasOwn(NAPI_COMMANDS, cmd)) {
      if (!deps.backend) {
        return failureEnvelope(`${IPC_BACKEND_UNAVAILABLE_MARKER} ${cmd}`);
      }
      return {
        ok: true,
        value: await NAPI_COMMANDS[cmd].run(deps.backend, args, deps),
      };
    }
    if (Object.hasOwn(deps.shell, cmd)) {
      if (cmd === "send_cli_chat_stream") {
        await assertCliAiAuditDispatchPrecondition(args, deps.backend);
      }
      return { ok: true, value: await deps.shell[cmd](args) };
    }
    return failureEnvelope(unimplementedError(cmd));
  } catch (e) {
    if (e instanceof WireErrorValue) {
      return failureEnvelope(e.message, e.value);
    }
    return failureEnvelope(toErrorString(e));
  }
}
