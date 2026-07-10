/**
 * external_mount のステート機械 + ファイル監視（設計書 §2 バッチ2）。
 *
 * Tauri 側 `commands/external_mount.rs`（registry + overlap + rollback）と
 * `external_mount/watch.rs`（notify watcher + debounce + `external-mount://` emit）
 * の **忠実移植**。notify の代わりに **chokidar** を使う（fs 監視は Node の領分）。
 *
 * ## 監視の設計判断（notify → chokidar）
 * - notify は OS の rename ペアリング（inotify IN_MOVED_FROM/TO）を拾って
 *   `renamed`（old+new）を emit するが、chokidar は rename を `unlink`+`add`
 *   として報告する。FE (`mountManager.ts`) は **content-hash 一致 + 5s 窓の
 *   `recentDeletes` 機構で remove→add を rename に再構成する**設計なので、
 *   `unlink`+`add` を素直に `removed`+`added` として流せば FE 側で吸収される。
 *   main 側での rename 合成は「削除済みファイルの内容を読めない」ため content
 *   照合が不可能で、FE の再構成層が正しい担当。よって `file-renamed` は
 *   allowlist には残すが main からは emit しない（契約は superset のまま）。
 *   main 側で unlink+add を時間近接だけで rename に合成することは**しない** —
 *   content 照合なしのペアリングは無関係な delete+create を誤ペア化して他ファイルの
 *   本文を別ノードへ付け替える data-integrity バグ（notify に無い新規リスク）を生む。
 *   FE の content-hash 照合こそが安全な担当層で、その content 依存の限界は不可避。
 *
 *   notify 経路との既知差分（純粋 rename = 内容不変は hash 一致で正しく再構成され差分なし）:
 *   1. **dirty rename**: 編集中（未保存）ファイルを外部 rename すると FE が removed を
 *      先に処理して `fileDeletedExternally` 警告トーストを 1 回出してから rename 再構成する。
 *   2. **content-diff rename（node identity 喪失）**: 外部編集 → 取り込み前（debounce 窓内）に
 *      同ファイルを rename、を 1 バッチで踏むと removed 側 hash（DB の旧内容）と added 側 hash
 *      （disk の新内容）が食い違い rename と認識されない → 新ノード作成 + 旧ノード archive。
 *      本文自体は失われないが in-app のノード同一性（timelapse チェーン / chat context /
 *      mention）がリセットされる。notify の native `renamed` は内容非依存で node を保持していた。
 *      稀な「編集直後 rename」競合のみ。faithful な回復には native rename ペア情報が要るが
 *      chokidar から取得不能（上記のとおり時間ペアリングは不採用）。
 * - `ignoreInitial: true` 必須 — notify は監視開始後の変化のみ報告し、初期一覧は
 *   register が返す scan で渡すため。これが無いと既存 `.md` 全部が `added` で発火。
 * - `followSymlinks: false` — Rust scan/watch の symlink 非追従と一致。
 * - `.md` ファイルのみ追跡（dir 変化は `unlinkDir`/`addDir` を購読しないことで無視。
 *   Rust でも dir-only イベントは FE 側で no-op になるため観測等価）。
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import { watch as chokidarWatch } from "chokidar";

import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import {
  atomicWriteText,
  fileMtimeIso,
  normalizeRelPath,
  pathsOverlap,
  readTextFile,
  rejectUnsafeMountPath,
  resolveUnderRoot,
  scanRoot,
} from "./externalMountFs.js";
import type { ScanResult } from "./externalMountFs.js";

/** watcher イベントを batch する debounce（Rust watch.rs `DEBOUNCE_MS`）。 */
const DEBOUNCE_MS = 500;

type FileEventKind = "changed" | "added" | "removed" | "renamed";

const CHANNEL_BY_KIND: Readonly<Record<FileEventKind, string>> = {
  changed: "external-mount://file-changed",
  added: "external-mount://file-added",
  removed: "external-mount://file-removed",
  renamed: "external-mount://file-renamed",
};

interface FileEventPayload {
  rootId: string;
  relPath: string;
  kind: FileEventKind;
  oldRelPath: string | null;
}

interface RegisteredRoot {
  id: string;
  path: string;
  label: string;
  /** 登録時の realpath。overlap 判定と resolve の基準。 */
  canonical: string;
}

/**
 * chokidar `FSWatcher` の構造的部分型（テストで fake を注入するための境界）。
 */
export interface MountWatcher {
  on(
    event: "add" | "change" | "unlink",
    listener: (filePath: string) => void,
  ): unknown;
  on(event: "error", listener: (err: unknown) => void): unknown;
  close(): Promise<void>;
}

export type WatcherFactory = (rootPath: string) => MountWatcher;

const defaultWatcherFactory: WatcherFactory = (rootPath) =>
  chokidarWatch(rootPath, {
    ignoreInitial: true,
    followSymlinks: false,
    // atomic: false 必須（chokidar 既定 true をあえて無効化）。
    // `atomic` は tmp+rename の atomic-write を単一 change に畳むため unlink の
    // emit を遅延させ、rename（別名）で **add が unlink より先**に届く（実測）。
    // FE の rename 再構成（mountManager.ts の recentDeletes）は removed→added の
    // 順で初めてノード同一性を保って sourceUri/title を更新できるため、この順序が
    // 崩れると rename が「旧ノード archive + 新ノード作成」に化けて node identity を
    // 失う。Grimodex 自身の atomic writeback は FE 側で isMuted 済みなので畳む必要は
    // なく、無効化して inotify 由来の unlink→add 順（notify と同じ）を素通しさせる。
    atomic: false,
  }) as unknown as MountWatcher;

export interface ExternalMountManagerOptions {
  watcherFactory?: WatcherFactory;
  debounceMs?: number;
}

/**
 * mount registry + watcher 群を保持する main プロセス常駐オブジェクト。
 * invoke ルーターは per-invoke に new せず、この単一インスタンスの handlers を
 * shell コマンド表へ merge する（registry/watcher の状態が invoke を跨いで
 * 持続する必要があるため — Rust の `State<ExternalMountState>` に相当）。
 */
export class ExternalMountManager {
  private readonly roots = new Map<string, RegisteredRoot>();
  private readonly watchers = new Map<string, MountWatcher>();
  private readonly pending = new Map<
    string,
    { events: FileEventPayload[]; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly watcherFactory: WatcherFactory;
  private readonly debounceMs: number;

  constructor(
    private readonly broadcast: (channel: string, payload: unknown) => void,
    options: ExternalMountManagerOptions = {},
  ) {
    this.watcherFactory = options.watcherFactory ?? defaultWatcherFactory;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  }

  // ── コマンド本体（Tauri external_mount_* の写像） ──────────────────────────

  async register(
    rootId: string,
    mountPath: string,
    label: string,
  ): Promise<ScanResult> {
    // open_workspace と対称の defense-in-depth（PIO-1）。
    await rejectUnsafeMountPath(mountPath);
    const st = await stat(mountPath).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`mount path is not a directory: ${mountPath}`);
    }
    // scan は木を walk して全 .md を読むため、registry の同期区間の外で実行する。
    const scan = await scanRoot(mountPath);
    const canonical = await realpath(mountPath);

    // overlap check + insert は同期（Node イベントループは await 無しなら非割込 =
    // Rust の MutexGuard 相当の原子性）。
    this.tryRegister(rootId, mountPath, label, canonical);
    try {
      this.startWatcher(rootId, canonical);
    } catch (e) {
      // watcher 起動失敗時は orphan mount を残さない（Rust register_with_rollback）。
      this.roots.delete(rootId);
      throw e;
    }
    return scan;
  }

  unregister(rootId: string): void {
    this.roots.delete(rootId);
    this.stopWatcher(rootId);
  }

  async readFile(rootId: string, relPath: string): Promise<string> {
    const abs = await resolveUnderRoot(this.lookupCanonical(rootId), relPath);
    return readTextFile(abs);
  }

  async writeFile(
    rootId: string,
    relPath: string,
    content: string,
  ): Promise<void> {
    const abs = await resolveUnderRoot(this.lookupCanonical(rootId), relPath);
    await atomicWriteText(abs, content);
  }

  async fileMtime(rootId: string, relPath: string): Promise<string> {
    const abs = await resolveUnderRoot(this.lookupCanonical(rootId), relPath);
    return fileMtimeIso(abs);
  }

  async scan(rootId: string): Promise<ScanResult> {
    return scanRoot(this.lookupCanonical(rootId));
  }

  /** app 終了時のクリーンアップ（watcher / タイマー全停止）。 */
  async disposeAll(): Promise<void> {
    for (const [, batch] of this.pending) clearTimeout(batch.timer);
    this.pending.clear();
    const closings: Array<Promise<void>> = [];
    for (const [, watcher] of this.watchers) {
      closings.push(watcher.close().catch(() => {}));
    }
    this.watchers.clear();
    this.roots.clear();
    await Promise.allSettled(closings);
  }

  // ── registry / watcher 内部 ───────────────────────────────────────────────

  private tryRegister(
    rootId: string,
    mountPath: string,
    label: string,
    canonical: string,
  ): void {
    for (const existing of this.roots.values()) {
      if (pathsOverlap(canonical, existing.canonical)) {
        throw new Error(
          `mount path overlaps with existing root: ${existing.label}`,
        );
      }
    }
    this.roots.set(rootId, { id: rootId, path: mountPath, label, canonical });
  }

  private lookupCanonical(rootId: string): string {
    const root = this.roots.get(rootId);
    if (!root) throw new Error(`unknown external root: ${rootId}`);
    return root.canonical;
  }

  private startWatcher(rootId: string, canonicalRoot: string): void {
    // Rust WatchRegistry::register は先に unregister する。
    this.stopWatcher(rootId);
    const watcher = this.watcherFactory(canonicalRoot);
    watcher.on("add", (p: string) =>
      this.onFsEvent(rootId, canonicalRoot, p, "added"),
    );
    watcher.on("change", (p: string) =>
      this.onFsEvent(rootId, canonicalRoot, p, "changed"),
    );
    watcher.on("unlink", (p: string) =>
      this.onFsEvent(rootId, canonicalRoot, p, "removed"),
    );
    watcher.on("error", (e: unknown) => {
      console.warn(
        `[external-mount] watcher error (${rootId}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
    this.watchers.set(rootId, watcher);
  }

  private stopWatcher(rootId: string): void {
    const watcher = this.watchers.get(rootId);
    if (watcher) {
      this.watchers.delete(rootId);
      void watcher.close().catch(() => {});
    }
    const batch = this.pending.get(rootId);
    if (batch) {
      clearTimeout(batch.timer);
      this.pending.delete(rootId);
    }
  }

  private onFsEvent(
    rootId: string,
    canonicalRoot: string,
    filePath: string,
    kind: FileEventKind,
  ): void {
    // should_track_path: `.md` のみ（dir イベントは購読していない）。
    if (path.extname(filePath) !== ".md") return;
    const relPath = normalizeRelPath(path.relative(canonicalRoot, filePath));
    this.queueEvent(rootId, { rootId, relPath, kind, oldRelPath: null });
  }

  /** Rust WatchRegistry::queue_event: 最後のイベントから debounceMs 後に flush。 */
  private queueEvent(rootId: string, payload: FileEventPayload): void {
    let batch = this.pending.get(rootId);
    if (!batch) {
      batch = {
        events: [],
        timer: setTimeout(() => this.flush(rootId), this.debounceMs),
      };
      this.pending.set(rootId, batch);
    } else {
      clearTimeout(batch.timer);
      batch.timer = setTimeout(() => this.flush(rootId), this.debounceMs);
    }
    batch.events.push(payload);
  }

  private flush(rootId: string): void {
    const batch = this.pending.get(rootId);
    if (!batch) return;
    this.pending.delete(rootId);
    // 挿入順を保持（rename 再構成のため removed が added より前に届く必要がある）。
    for (const ev of batch.events) {
      this.broadcast(CHANNEL_BY_KIND[ev.kind], {
        rootId: ev.rootId,
        relPath: ev.relPath,
        oldRelPath: ev.oldRelPath,
      });
    }
  }

  /** invoke ルーターへ merge する shell コマンドハンドラ集合。 */
  buildHandlers(): ShellCommandHandlers {
    return {
      external_mount_register: async (args: CommandArgs) =>
        this.register(
          requireStr(args, "rootId", "external_mount_register"),
          requireStr(args, "path", "external_mount_register"),
          requireStr(args, "label", "external_mount_register"),
        ),
      external_mount_unregister: (args: CommandArgs) => {
        this.unregister(
          requireStr(args, "rootId", "external_mount_unregister"),
        );
        return Promise.resolve(null);
      },
      external_mount_read_file: async (args: CommandArgs) =>
        this.readFile(
          requireStr(args, "rootId", "external_mount_read_file"),
          requireStr(args, "relPath", "external_mount_read_file"),
        ),
      external_mount_write_file: async (args: CommandArgs) => {
        await this.writeFile(
          requireStr(args, "rootId", "external_mount_write_file"),
          requireStr(args, "relPath", "external_mount_write_file"),
          requireStr(args, "content", "external_mount_write_file"),
        );
        return null;
      },
      external_mount_file_mtime: async (args: CommandArgs) =>
        this.fileMtime(
          requireStr(args, "rootId", "external_mount_file_mtime"),
          requireStr(args, "relPath", "external_mount_file_mtime"),
        ),
      external_mount_scan: async (args: CommandArgs) =>
        this.scan(requireStr(args, "rootId", "external_mount_scan")),
    };
  }
}

function requireStr(args: CommandArgs, key: string, cmd: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(
      `invalid args \`${key}\` for command \`${cmd}\`: expected a string`,
    );
  }
  return value;
}

/**
 * 単一インスタンスを生成し、invoke ルーターへ渡す handlers と終了時
 * クリーンアップを返す。`broadcast` は events.ts の broadcastEvent
 * （全窓配信 = external-mount:// の全窓 broadcast 契約）。
 */
export function createExternalMountManager(
  broadcast: (channel: string, payload: unknown) => void,
  options?: ExternalMountManagerOptions,
): {
  handlers: ShellCommandHandlers;
  disposeAll: () => Promise<void>;
} {
  const manager = new ExternalMountManager(broadcast, options);
  return {
    handlers: manager.buildHandlers(),
    disposeAll: () => manager.disposeAll(),
  };
}
