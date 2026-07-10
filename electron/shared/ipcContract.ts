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
 * - **コマンド表**: napi 垂直スライス 12 コマンド（当初 7 + trash_bin 5 —
 *   workspace 読み込み時に必ず呼ばれる trash_bin_list が IPC_UNIMPLEMENTED で
 *   起動のたびにゴミ箱エラートーストを出したため追補）+ main-TS 2 コマンド。
 *   引数アダプタ（Tauri の camelCase→snake_case 自動変換の写像）はコマンド
 *   ごとに明示する。この表が Phase 3 の 145 コマンド一括対応の正本になる。
 * - **イベント allowlist**: 前方一致ではなく列挙制。listen / emit とも
 *   allowlist 外は拒否する（§5.4）。
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
  /** windowControls（minimize / toggleMaximize / close / isMaximized）。 */
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
 * Rust 発チャネル（src-tauri の emit 実測。Phase 3 で TSFn 経路へ実配線）
 * + renderer 発 codex 窓間同期 3ch + external-mount watcher 4ch
 * + napi Phase 2 実証チャネル 2ch（§7.1）。
 */
export const EVENT_CHANNEL_ALLOWLIST: readonly string[] = [
  // Rust 発: AI ストリーミング（ai.rs / ai_responses.rs / cli_ai.rs の
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
  // Rust 発: license / post_effect / semantic / vivliostyle
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
  // renderer 発: codex 窓間同期（codexWindowSync.ts。§7.1 で Phase 2 受け入れ対象）
  "codex:data-changed",
  "codex:lock-event",
  "codex:select-entry",
  // Rust 発: external-mount watcher（useExternalMountListener.ts）
  "external-mount://file-added",
  "external-mount://file-changed",
  "external-mount://file-removed",
  "external-mount://file-renamed",
  // napi 発: Phase 2 の TSFn end-to-end 実証チャネル（§7.1、FE 購読者なし）
  "backend:ready",
  "workspace:opened",
];

const EVENT_CHANNEL_SET: ReadonlySet<string> = new Set(EVENT_CHANNEL_ALLOWLIST);

export function isAllowedEventChannel(channel: string): boolean {
  return EVENT_CHANNEL_SET.has(channel);
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
// get_license_state スタブの形状（licensing 無効ビルドと同一 — §4.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * src-tauri/src/license.rs `disabled_dto()` のワイヤ写像（camelCase）。
 * Phase 3 で grimodex-core の状態機械（napi 経由）へ差し替える。
 */
export const DISABLED_LICENSE_STATE = {
  licensingEnabled: false,
  status: "disabled",
  trialDaysRemaining: null,
  graceDaysRemaining: null,
  keyTail: null,
  activatedAt: null,
  lastValidatedAt: null,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// napi Backend の構造型（electron/native/grimodex-node/index.d.ts と同形。
// 生成物 index.js は gitignore のため import せず構造的に一致させる）
// ─────────────────────────────────────────────────────────────────────────────

export interface NapiBackendLike {
  dbExecute(sql: string, params: unknown, method: string): Promise<string>;
  dbExecuteBatch(statements: unknown): Promise<string>;
  openWorkspace(path: string): Promise<string>;
  validateWorkspacePath(path: string): boolean;
  getGlobalSettings(): Promise<string>;
  saveGlobalSettings(settings: unknown): Promise<void>;
  timelapseAppendBatch(
    projectId: string,
    sessionId: string,
    events: unknown,
  ): Promise<string>;
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
  onEvent(callback: (...args: unknown[]) => unknown): void;
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

function requirePresent(args: CommandArgs, key: string, cmd: string): unknown {
  if (!Object.hasOwn(args, key) || args[key] === undefined) {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: missing required key ${key}`,
    );
  }
  return args[key];
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

/** napi は JSON 文字列を返す（Tauri ワイヤと同形にするため parse して返す）。 */
function parseWire(json: string): unknown {
  return JSON.parse(json) as unknown;
}

export interface NapiCommandSpec {
  /**
   * FE 引数（Tauri 命名 = camelCase キー）→ Backend メソッド呼び出しへの
   * 明示写像。JSON 文字列返りは parse 済みオブジェクトにして Tauri の
   * invoke 返り値と同形にする。
   */
  run(backend: NapiBackendLike, args: CommandArgs): Promise<unknown>;
}

/** napi 実装コマンド（垂直スライス 12 コマンド = 当初 7 + trash_bin 5、§4.3）。 */
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
};

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

/** main-TS 実装コマンド名（§4.3 の表 + Phase 3 追補の export / logs）。 */
export const SHELL_COMMAND_NAMES: readonly string[] = [
  "set_window_vibrancy",
  "get_license_state",
  "export_save_text",
  "export_save_bytes",
  "open_log_dir",
];

// ─────────────────────────────────────────────────────────────────────────────
// invoke ディスパッチ（純関数 — ipc.ts はこれを ipcMain.handle に接続するだけ）
// ─────────────────────────────────────────────────────────────────────────────

export interface DispatchDeps {
  /** .node ロード失敗時は null（fail-soft: 明示エラー envelope を返す）。 */
  backend: NapiBackendLike | null;
  shell: ShellCommandHandlers;
}

/**
 * コマンド 1 件を実行して Envelope に畳む。**決して throw しない**（§5.2）。
 * 優先順位: main-TS ハンドラ → napi コマンド表 → IPC_UNIMPLEMENTED。
 */
export async function dispatchInvoke(
  cmd: string,
  args: CommandArgs,
  deps: DispatchDeps,
): Promise<Envelope> {
  try {
    if (Object.hasOwn(deps.shell, cmd)) {
      return { ok: true, value: await deps.shell[cmd](args) };
    }
    if (Object.hasOwn(NAPI_COMMANDS, cmd)) {
      if (!deps.backend) {
        return {
          ok: false,
          error: `${IPC_BACKEND_UNAVAILABLE_MARKER} ${cmd}`,
        };
      }
      return {
        ok: true,
        value: await NAPI_COMMANDS[cmd].run(deps.backend, args),
      };
    }
    return { ok: false, error: unimplementedError(cmd) };
  } catch (e) {
    if (e instanceof WireErrorValue) {
      return { ok: false, error: e.message, errorValue: e.value };
    }
    return { ok: false, error: toErrorString(e) };
  }
}
