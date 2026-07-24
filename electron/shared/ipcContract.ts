/**
 * typed IPC ブリッジの契約実体（設計書 §5.2 / §5.4、Phase 2 S4）。
 *
 * - **envelope 方式**: Electron の `ipcMain.handle` の throw は
 *   `"Error invoking remote method …"` プレフィックスでワイヤを汚すため、
 *   main は決して throw せず `{ ok, value | error }` を resolve する。
 *   renderer 側（src/lib/tauri.ts の electron 分岐、S5）が
 *   `if (!res.ok) throw res.error;` で**生文字列 reject** に解封する —
 *   Tauri のエラー文字列契約（`WORKSPACE_SWITCHING` / `No workspace is open`
 *   マーカーの部分一致判定 126 箇所）の保存が最重要。
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

export type Envelope<T = unknown> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: string;
      /**
       * Tauri がエラーを **object** で serialize するコマンド（現状 lint_text の
       * `LintError` = `{type, data}` のみ）の reject 値。renderer 側の解封は
       * `errorValue ?? error` を throw する — FE `formatLintError` の
       * `{type, data}` 分岐を保存するため（§5.2 の例外規定）。
       */
      errorValue?: unknown;
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

export interface NapiBackendLike {
  dbExecute(sql: string, params: unknown, method: string): Promise<string>;
  dbExecuteBatch(statements: unknown): Promise<string>;
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
  getGlobalSettings(): Promise<string>;
  saveGlobalSettings(settings: unknown): Promise<void>;
  seedSampleWorkspace?(language: string, aiPolicy: string): Promise<string>;
  importWebEditorWorkspace?(handoffJson: string): Promise<string>;
  timelapseAppendBatch(
    projectId: string,
    sessionId: string,
    events: unknown,
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
  integrityCheck(): Promise<string>;
  repairIntegrity(): Promise<string>;
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
  // Semantic Phase 3 Batch 4。optional は旧 .node とのversion skewを
  // requireNapiMethodで明示エラーにするため。usize相当はIPCでu32へ狭める。
  semanticDownloadModel?(language: string): Promise<string>;
  semanticIndexScene?(sceneId: string): Promise<string>;
  semanticSearch?(
    projectId: string,
    query: string,
    limit: number,
    sceneScope?: string | null,
    descriptionMode?: boolean | null,
  ): Promise<string>;
  codexIndexEntry?(entryId: string): Promise<string>;
  codexSemanticSearch?(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  codexIndexStatus?(projectId: string): Promise<string>;
  codexReindexAll?(projectId: string): Promise<string>;
  eventsIndexEntry?(eventId: string): Promise<string>;
  eventsSemanticSearch?(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  eventsIndexStatus?(projectId: string): Promise<string>;
  eventsReindexAll?(projectId: string): Promise<string>;
  chatIndexMessage?(messageId: string): Promise<string>;
  chatMessageSearch?(
    projectId: string,
    query: string,
    limit: number,
  ): Promise<string>;
  chatIndexStatus?(projectId: string): Promise<string>;
  chatReindexAll?(projectId: string): Promise<string>;
  semanticIndexStatus?(projectId: string): Promise<string>;
  semanticReindexAll?(
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
  plotThreadDelete(id: string): Promise<void>;
  plotThreadList(projectId: string): Promise<string>;
  plotThreadLinkCreate(payload: unknown): Promise<string>;
  plotThreadLinkUpdate(id: string, patch: unknown): Promise<string>;
  plotThreadLinkDelete(id: string): Promise<void>;
  plotThreadListLinks(projectId: string): Promise<string>;
  foreshadowCreate(payload: unknown): Promise<string>;
  foreshadowUpdate(id: string, patch: unknown): Promise<string>;
  foreshadowDelete(id: string): Promise<void>;
  foreshadowListWithLabels(projectId: string): Promise<string>;
  foreshadowListOpenForContext(projectId: string): Promise<string>;
  foreshadowGetSceneInfo(sceneId: string): Promise<string>;
  foreshadowGetSceneContext(sceneId: string): Promise<string>;
  foreshadowListByCodexEntry(codexEntryId: string): Promise<string>;
  foreshadowGetChapterStats(chapterId: string): Promise<string>;
  foreshadowGetSetup(setupId: string): Promise<string>;
  foreshadowUpdateSetup(id: string, patch: unknown): Promise<void>;
  foreshadowGet(id: string): Promise<string>;
  foreshadowLinkCodex(foreshadowId: string, codexId: string): Promise<void>;
  foreshadowUnlinkCodex(foreshadowId: string, codexId: string): Promise<void>;
  foreshadowListLinkedCodex(foreshadowId: string): Promise<string>;
  foreshadowSetSetupStrength(
    setupId: string,
    strength?: string | null,
  ): Promise<void>;
  foreshadowSetupCreateAi(input: unknown): Promise<void>;
  foreshadowResolveOrphan(payload: unknown): Promise<string>;
  foreshadowSaveAnchorsForScene(
    sceneId: string,
    setups: unknown,
    payoffs: unknown,
    docContentSize: number,
  ): Promise<void>;
  foreshadowLoadAnchorsForScene(sceneId: string): Promise<string>;
  // agent_writes 18 コマンド（すべて単一 payload → AgentWriteResult/ProseStageResult）
  agentCodexCreate(payload: unknown): Promise<string>;
  agentCodexUpdate(payload: unknown): Promise<string>;
  agentWriteBundle(payload: unknown): Promise<string>;
  agentSnippetCreate(payload: unknown): Promise<string>;
  agentProposeSceneBody(payload: unknown): Promise<string>;
  agentAcceptProseStage(payload: unknown): Promise<string>;
  agentDiscardProseStage(payload: unknown): Promise<string>;
  agentApplyUndoJournal(payload: unknown): Promise<string>;
  agentForeshadowCreate(payload: unknown): Promise<string>;
  agentForeshadowUpdate(payload: unknown): Promise<string>;
  agentEventCreate(payload: unknown): Promise<string>;
  agentEventUpdate(payload: unknown): Promise<string>;
  agentEventDelete(payload: unknown): Promise<string>;
  agentEventSetParticipants(payload: unknown): Promise<string>;
  agentSceneEventLink(payload: unknown): Promise<string>;
  agentSceneEventUnlink(payload: unknown): Promise<string>;
  agentEventRelationAdd(payload: unknown): Promise<string>;
  agentEventRelationRemove(payload: unknown): Promise<string>;
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
  abortChatStream(): void;
  // AI Phase 3b（settings snapshot + safeStorage key注入は3a chatと同じ）。
  // optional は旧 .node とのバージョンスキューを型境界で表すため。コマンド実行時は
  // requireNapiMethod が必ず存在確認し、欠落を明示エラーにする。
  saveAiSettings?(settings: unknown): Promise<void>;
  sendInlineAiStream?(
    args: unknown,
    settings: unknown,
    apiKey: string,
  ): Promise<void>;
  abortInlineAiStream?(): void;
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

/** native mutationは既にcommit済みなので、window配信失敗でinvokeを失敗へ反転しない。 */
function broadcastBestEffort(
  deps: DispatchDeps,
  channel: string,
  payload: unknown,
): void {
  try {
    deps.broadcast?.(channel, payload);
  } catch (error) {
    console.warn(`[ipc] ${channel} broadcast failed:`, error);
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
  } catch (error) {
    console.warn(
      "[ipc] failed to read license state after revalidate error:",
      error,
    );
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
          requirePresent(a, "events", "timelapse_append_batch"),
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
  // trash_bin 5 コマンド（起動時の trash_bin_list IPC_UNIMPLEMENTED 修正）。
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
  //   integrity_check() / repair_integrity()
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
    run: async (b) => parseWire(await b.integrityCheck()),
  },
  repair_integrity: {
    run: async (b) => parseWire(await b.repairIntegrity()),
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
  semantic_index_scene: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.semanticIndexScene,
          "semanticIndexScene",
        )(requireString(a, "sceneId", "semantic_index_scene")),
      ),
  },
  semantic_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.semanticSearch, "semanticSearch")(
          requireString(a, "projectId", "semantic_search"),
          requireString(a, "query", "semantic_search"),
          requireUnsignedInteger(a, "limit", "semantic_search"),
          optionalString(a, "sceneScope", "semantic_search"),
          optionalBoolean(a, "descriptionMode", "semantic_search"),
        ),
      ),
  },
  codex_index_entry: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.codexIndexEntry,
          "codexIndexEntry",
        )(requireString(a, "entryId", "codex_index_entry")),
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
        )(requireString(a, "projectId", "codex_reindex_all")),
      ),
  },
  events_index_entry: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.eventsIndexEntry,
          "eventsIndexEntry",
        )(requireString(a, "eventId", "events_index_entry")),
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
        )(requireString(a, "projectId", "events_reindex_all")),
      ),
  },
  chat_index_message: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(
          b,
          b.chatIndexMessage,
          "chatIndexMessage",
        )(requireString(a, "messageId", "chat_index_message")),
      ),
  },
  chat_message_search: {
    run: async (b, a) =>
      parseWire(
        await requireNapiMethod(b, b.chatMessageSearch, "chatMessageSearch")(
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
        )(requireString(a, "projectId", "chat_reindex_all")),
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
        await requireNapiMethod(
          b,
          b.semanticReindexAll,
          "semanticReindexAll",
        )(
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
          requirePresent(a, "payload", "plot_thread_create"),
        ),
      ),
  },
  plot_thread_update: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadUpdate(
          requireString(a, "id", "plot_thread_update"),
          requirePresent(a, "patch", "plot_thread_update"),
        ),
      ),
  },
  plot_thread_delete: {
    // unit 返りコマンドは null を resolve（ワイヤ同形）
    run: async (b, a) => {
      await b.plotThreadDelete(requireString(a, "id", "plot_thread_delete"));
      return null;
    },
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
          requirePresent(a, "payload", "plot_thread_link_create"),
        ),
      ),
  },
  plot_thread_link_update: {
    run: async (b, a) =>
      parseWire(
        await b.plotThreadLinkUpdate(
          requireString(a, "id", "plot_thread_link_update"),
          requirePresent(a, "patch", "plot_thread_link_update"),
        ),
      ),
  },
  plot_thread_link_delete: {
    run: async (b, a) => {
      await b.plotThreadLinkDelete(
        requireString(a, "id", "plot_thread_link_delete"),
      );
      return null;
    },
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
          requirePresent(a, "payload", "foreshadow_create"),
        ),
      ),
  },
  foreshadow_update: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowUpdate(
          requireString(a, "id", "foreshadow_update"),
          requirePresent(a, "patch", "foreshadow_update"),
        ),
      ),
  },
  foreshadow_delete: {
    run: async (b, a) => {
      await b.foreshadowDelete(requireString(a, "id", "foreshadow_delete"));
      return null;
    },
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
    run: async (b, a) => {
      await b.foreshadowUpdateSetup(
        requireString(a, "id", "foreshadow_update_setup"),
        requirePresent(a, "patch", "foreshadow_update_setup"),
      );
      return null;
    },
  },
  foreshadow_get: {
    run: async (b, a) =>
      parseWire(
        await b.foreshadowGet(requireString(a, "id", "foreshadow_get")),
      ),
  },
  foreshadow_link_codex: {
    run: async (b, a) => {
      await b.foreshadowLinkCodex(
        requireString(a, "foreshadowId", "foreshadow_link_codex"),
        requireString(a, "codexId", "foreshadow_link_codex"),
      );
      return null;
    },
  },
  foreshadow_unlink_codex: {
    run: async (b, a) => {
      await b.foreshadowUnlinkCodex(
        requireString(a, "foreshadowId", "foreshadow_unlink_codex"),
        requireString(a, "codexId", "foreshadow_unlink_codex"),
      );
      return null;
    },
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
    // strength は Option<String>: 文字列以外（null / 省略）は None（列クリア）。
    run: async (b, a) => {
      const strength = typeof a.strength === "string" ? a.strength : undefined;
      await b.foreshadowSetSetupStrength(
        requireString(a, "setupId", "foreshadow_set_setup_strength"),
        strength,
      );
      return null;
    },
  },
  foreshadow_setup_create_ai: {
    // FE は 12 個の flat な camelCase キーを送る（payload ラップ無し）。args
    // オブジェクトをそのまま渡し、napi 側 from_wire が SetupCreateAiInput に落とす。
    run: async (b, a) => {
      await b.foreshadowSetupCreateAi(a);
      return null;
    },
  },
  foreshadow_resolve_orphan: {
    // Option<String> — reinsert 時のみ new_id、その他 null（parseWire で復元）。
    run: async (b, a) =>
      parseWire(
        await b.foreshadowResolveOrphan(
          requirePresent(a, "payload", "foreshadow_resolve_orphan"),
        ),
      ),
  },
  foreshadow_save_anchors_for_scene: {
    run: async (b, a) => {
      await b.foreshadowSaveAnchorsForScene(
        requireString(a, "sceneId", "foreshadow_save_anchors_for_scene"),
        requirePresent(a, "setups", "foreshadow_save_anchors_for_scene"),
        requirePresent(a, "payoffs", "foreshadow_save_anchors_for_scene"),
        requireNumber(a, "docContentSize", "foreshadow_save_anchors_for_scene"),
      );
      return null;
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
  // agent_writes 18 コマンド（Phase 3 バッチ1 — grimodex-db::agent_writes を Tauri と
  // 共用）。すべて FE は単一の `{ payload }` を送り、AgentWriteResult /
  // ProseStageResult (camelCase) が返る。payload はそのまま素通し（napi 側 from_wire
  // が serde rename_all + normalize_integer_numbers で受ける）。
  agent_codex_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexCreate(
          requirePresent(a, "payload", "agent_codex_create"),
        ),
      ),
  },
  agent_codex_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentCodexUpdate(
          requirePresent(a, "payload", "agent_codex_update"),
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
          requirePresent(a, "payload", "agent_snippet_create"),
        ),
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
      parseWire(
        await b.agentApplyUndoJournal(
          requirePresent(a, "payload", "agent_apply_undo_journal"),
        ),
      ),
  },
  agent_foreshadow_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentForeshadowCreate(
          requirePresent(a, "payload", "agent_foreshadow_create"),
        ),
      ),
  },
  agent_foreshadow_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentForeshadowUpdate(
          requirePresent(a, "payload", "agent_foreshadow_update"),
        ),
      ),
  },
  agent_event_create: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventCreate(
          requirePresent(a, "payload", "agent_event_create"),
        ),
      ),
  },
  agent_event_update: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventUpdate(
          requirePresent(a, "payload", "agent_event_update"),
        ),
      ),
  },
  agent_event_delete: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventDelete(
          requirePresent(a, "payload", "agent_event_delete"),
        ),
      ),
  },
  agent_event_set_participants: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventSetParticipants(
          requirePresent(a, "payload", "agent_event_set_participants"),
        ),
      ),
  },
  agent_scene_event_link: {
    run: async (b, a) =>
      parseWire(
        await b.agentSceneEventLink(
          requirePresent(a, "payload", "agent_scene_event_link"),
        ),
      ),
  },
  agent_scene_event_unlink: {
    run: async (b, a) =>
      parseWire(
        await b.agentSceneEventUnlink(
          requirePresent(a, "payload", "agent_scene_event_unlink"),
        ),
      ),
  },
  agent_event_relation_add: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventRelationAdd(
          requirePresent(a, "payload", "agent_event_relation_add"),
        ),
      ),
  },
  agent_event_relation_remove: {
    run: async (b, a) =>
      parseWire(
        await b.agentEventRelationRemove(
          requirePresent(a, "payload", "agent_event_relation_remove"),
        ),
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
    // rename_all 無し）。オブジェクトをそのまま渡す。
    run: async (b, a) =>
      parseWire(
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
      return parseWire(
        await startPostEffectRun(args, settings, apiKey, apiKeyError),
      );
    },
  },
  start_post_effect_run_multi: {
    run: async (b, a, d) => {
      const args = requireRecord(a, "args", "start_post_effect_run_multi");
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
      return parseWire(
        await startPostEffectRunMulti(args, settings, apiKey, apiKeyError),
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
      validateOptionalPositiveU32(
        a,
        "requestMaxOutputTokens",
        "send_chat_message",
      );
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_chat_message",
      );
      return parseWire(await b.sendChatMessage(a, settings, apiKey));
    },
  },
  send_chat_message_stream: {
    // fire-and-forget ストリーム。チャンク/完了/エラーは chat:stream-* イベント経由。
    // Tauri 同様、全ストリーム完了後に resolve（FE は SLOW_COMMANDS で 300s 許容）。
    run: async (b, a, d) => {
      validateOptionalPositiveU32(
        a,
        "requestMaxOutputTokens",
        "send_chat_message_stream",
      );
      const { settings, apiKey } = await resolveRequiredAiKeyAndSettings(
        b,
        a,
        d,
        "send_chat_message_stream",
      );
      await b.sendChatMessageStream(a, settings, apiKey);
      return null;
    },
  },
  abort_chat_stream: {
    // 純メモリの atomic store（同一 Backend の chat_abort を立てる）。unit 返り。
    run: async (b) => {
      b.abortChatStream();
      return null;
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
    run: async (b) => {
      requireNapiMethod(b, b.abortInlineAiStream, "abortInlineAiStream")();
      return null;
    },
  },
  send_agent_message: {
    run: async (b, a, d) => {
      requirePresent(a, "messages", "send_agent_message");
      requirePresent(a, "tools", "send_agent_message");
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
      return parseWire(await sendAgentMessage(a, settings, apiKey));
    },
  },
  list_ai_models: {
    run: async (b, a, d) => {
      requireString(a, "provider", "list_ai_models");
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
): Promise<{ settings: unknown; apiKey: string }> {
  if (!deps.secrets) {
    throw new Error(`IPC_SECRETS_UNAVAILABLE: ${cmd}`);
  }
  const settings = parseWire(await backend.getAiSettings());
  const apiKey = deps.secrets.resolveApiKeyForRequest(
    settings,
    args.provider,
    args.endpointId,
  );
  return { settings, apiKey };
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
        return {
          ok: false,
          error: `${IPC_BACKEND_UNAVAILABLE_MARKER} ${cmd}`,
        };
      }
      return {
        ok: true,
        value: await NAPI_COMMANDS[cmd].run(deps.backend, args, deps),
      };
    }
    if (Object.hasOwn(deps.shell, cmd)) {
      return { ok: true, value: await deps.shell[cmd](args) };
    }
    return { ok: false, error: unimplementedError(cmd) };
  } catch (e) {
    if (e instanceof WireErrorValue) {
      return { ok: false, error: e.message, errorValue: e.value };
    }
    return { ok: false, error: toErrorString(e) };
  }
}
