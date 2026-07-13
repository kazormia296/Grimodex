/**
 * external_mount のファイル I/O ロジック（設計書 §2 バッチ2）。
 *
 * Tauri 側 `src-tauri/src/external_mount/{io,path,scan,hash}.rs` +
 * `grimodex-db::open::reject_unsafe_workspace_path`（PIO-1）の **忠実移植**。
 * electron / *.node に依存しない純 Node モジュールに保つ（vitest.electron.config.ts
 * の node 環境単体テスト対象 — chokidar やステート機械は externalMount.ts 側）。
 *
 * 契約の要点（Rust とワイヤ同形）:
 * - `resolveUnderRoot`: `..` 拒否・絶対パス拒否・canonical 包含チェック。
 * - `readTextFile`: 32 MiB 上限（RUST-DOS-01）+ CRLF→LF 正規化。
 * - `atomicWriteText`: tmp + fsync + rename（LF 出力）。
 * - `scanRoot`: `.md` のみ・symlink 非追従・深さ/件数/バイト上限、rel/name camelCase。
 * - `contentHash`: LF 正規化後の SHA-256 hex（Rust `external_mount::hash` と一致）。
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 上限定数（Rust と一致）
// ─────────────────────────────────────────────────────────────────────────────

/** 単一テキストファイルの読込上限（Rust io.rs `MAX_TEXT_FILE_BYTES`）。 */
export const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024; // 32 MiB

/** スキャン時のディレクトリ最大ネスト深度（Rust scan.rs `MAX_SCAN_DEPTH`）。 */
export const MAX_SCAN_DEPTH = 64;

/** 1 スキャンで materialize する `.md` の最大件数（Rust `MAX_SCAN_FILES`）。 */
export const MAX_SCAN_FILES = 50_000;

/** 1 スキャンの累積 `.md` バイト上限（Rust `MAX_SCAN_TOTAL_BYTES`）。 */
export const MAX_SCAN_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MiB

// ─────────────────────────────────────────────────────────────────────────────
// 型（FE src/features/external-mount/types.ts と同形 — electron は src を import
// できないため構造的に一致させる。camelCase）
// ─────────────────────────────────────────────────────────────────────────────

export interface ScannedDir {
  relPath: string;
  name: string;
}

export interface ScannedFile {
  relPath: string;
  content: string;
  mtime: string;
  contentHash: string;
}

export interface ScanResult {
  dirs: ScannedDir[];
  files: ScannedFile[];
}

// ─────────────────────────────────────────────────────────────────────────────
// hash（Rust external_mount::hash）
// ─────────────────────────────────────────────────────────────────────────────

/** CRLF → LF 正規化（ハッシュ / 読込で使用）。 */
export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/** 正規化済み内容の SHA-256 hex。Rust `content_hash` と一致。 */
export function contentHash(content: string): string {
  return createHash("sha256")
    .update(normalizeContent(content), "utf8")
    .digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// path helpers（Rust external_mount::path）
// ─────────────────────────────────────────────────────────────────────────────

/** 保存 / IPC 用に相対パスを正規化（forward slash）。Rust `normalize_rel_path`。 */
export function normalizeRelPath(relPath: string): string {
  return relPath.split(path.sep).join("/").replace(/\\/g, "/");
}

/**
 * `child` が `parent` と等しい or その厳密なサブディレクトリなら true。
 * 境界安全（`/root2` は `/root` に含まれない）。Rust `one_contains_other`
 * の「等値 or 直下」判定。Windows は case-insensitive。
 */
export function isPathInside(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  if (process.platform === "win32") {
    return child.toLowerCase().startsWith(withSep.toLowerCase());
  }
  return child.startsWith(withSep);
}

/** 一方が他方を含む（どちらの向きでも）。Rust `overlap_check` の判定核。 */
export function pathsOverlap(a: string, b: string): boolean {
  return isPathInside(a, b) || isPathInside(b, a);
}

// ─────────────────────────────────────────────────────────────────────────────
// reject_unsafe_workspace_path（PIO-1、grimodex-db::open）
// ─────────────────────────────────────────────────────────────────────────────

/** システムルート判定（Rust `is_system_directory`）。 */
function isSystemDirectory(target: string): boolean {
  if (process.platform === "win32") {
    // %SystemRoot% / Program Files 配下を拒否（drive letter 非依存に env から解決）。
    const denyEnv = ["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"];
    return denyEnv.some((name) => {
      const base = process.env[name];
      if (!base) return false;
      return (
        isPathInside(target, path.resolve(base)) ||
        target === path.resolve(base)
      );
    });
  }
  if (target === "/") return true;
  // ユーザデータが置かれない明白なシステムルートのみ（/tmp, /var/folders 等は除外）。
  const deny = [
    "/bin",
    "/sbin",
    "/boot",
    "/dev",
    "/etc",
    "/lib",
    "/lib64",
    "/proc",
    "/sys",
    "/usr",
    "/System",
    "/private/etc",
  ];
  return deny.some((d) => target === d || isPathInside(target, d));
}

/**
 * mount root の安全性検証（Rust `reject_unsafe_workspace_path`）。
 * 絶対パス必須・`..` 拒否・既存の最近接祖先を canonicalize してシステム
 * ディレクトリ配下を拒否。renderer 侵害時に `/etc` 等を root 登録され
 * external_mount_read_file の踏み台にされるのを防ぐ（PIO-1）。
 */
export async function rejectUnsafeMountPath(target: string): Promise<void> {
  if (!path.isAbsolute(target)) {
    throw new Error(`workspace path must be absolute: ${target}`);
  }
  const segments = target.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    throw new Error(`workspace path must not contain '..': ${target}`);
  }
  // root ディレクトリ自体はまだ存在しないことがあるため、既存の最近接祖先を
  // canonicalize する。
  let probe = target;
  let canonical: string | null = null;

  while (true) {
    try {
      canonical = await realpath(probe);
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  if (canonical !== null && isSystemDirectory(canonical)) {
    throw new Error(
      `refusing to create a workspace under a system directory: ${canonical}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// resolve / read / write / mtime（Rust external_mount::io）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `relPath` を `canonicalRoot` 配下に解決し traversal（`..`）を拒否する
 * （Rust `resolve_under_root`）。canonicalRoot は登録時に realpath 済みを渡す。
 * joined は canonicalize（realpath）するため対象は**存在必須**（Rust の
 * `joined.canonicalize()` と同契約 — 書込は既存ファイルにのみ成立）。
 */
export async function resolveUnderRoot(
  canonicalRoot: string,
  relPath: string,
): Promise<string> {
  const segments = relPath.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`path traversal rejected: ${relPath}`);
    }
  }
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new Error(`absolute paths are not allowed: ${relPath}`);
  }
  const joined = path.join(canonicalRoot, relPath);
  let canonical: string;
  try {
    canonical = await realpath(joined);
  } catch {
    throw new Error(`failed to resolve ${joined}`);
  }
  if (!isPathInside(canonical, canonicalRoot)) {
    throw new Error(`path escapes mount root: ${relPath}`);
  }
  return canonical;
}

/** UTF-8 テキスト読込（32 MiB 上限 + CRLF→LF）。Rust `read_text_file`。 */
export async function readTextFile(absPath: string): Promise<string> {
  // Open before inspecting size so the check and read refer to the same file.
  // POSIX O_NOFOLLOW also prevents a path swap from redirecting the read to a
  // symlink target after resolveUnderRoot() has canonicalized the path.
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  const fh = await open(absPath, constants.O_RDONLY | noFollow);
  try {
    const meta = await fh.stat();
    if (meta.size > MAX_TEXT_FILE_BYTES) {
      throw new Error(
        `file too large to read (${meta.size} bytes, limit ${MAX_TEXT_FILE_BYTES} bytes): ${absPath}`,
      );
    }
    const raw = await fh.readFile("utf8");
    return raw.replace(/\r\n/g, "\n");
  } finally {
    await fh.close();
  }
}

export interface AtomicWriteTextOptions {
  /** テスト用の一時ファイル名生成器。通常は暗号学的乱数を使う。 */
  randomId?: () => string;
}

function exclusiveWriteFlags(): number {
  // O_EXCL makes creation atomic even on platforms without O_NOFOLLOW. On
  // POSIX, O_NOFOLLOW additionally protects against a pre-existing symlink.
  const noFollow =
    process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
}

/**
 * POSIX の rename durability を少し強めるため、親ディレクトリも sync する。
 * Windows ではディレクトリ FileHandle の sync が利用できないため省略する。
 */
async function syncParentDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: FileHandle | null = null;
  try {
    handle = await open(parent, constants.O_RDONLY);
    await handle.sync();
  } catch {
    // Directory fsync is best-effort on filesystems that do not expose it.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * 排他的なランダム tmp + fsync + rename のアトミック書込（LF 出力）。
 * Rust `atomic_write_text` と同様、tmp の symlink 追従と名前競合を防ぐ。
 */
export async function atomicWriteText(
  absPath: string,
  content: string,
  options: AtomicWriteTextOptions = {},
): Promise<void> {
  const parent = path.dirname(absPath);
  await mkdir(parent, { recursive: true });
  const normalized = content.replace(/\r\n/g, "\n");
  const randomId = options.randomId ?? randomUUID;
  const destinationMode =
    process.platform === "win32"
      ? null
      : await lstat(absPath)
          .then((metadata) =>
            metadata.isFile() ? metadata.mode & 0o777 : null,
          )
          .catch(() => null);
  const tmpPath = path.join(
    parent,
    `.${path.basename(absPath)}-${process.pid}-${randomId()}.tmp`,
  );
  let fh: FileHandle | null = null;
  let tempCreated = false;
  try {
    fh = await open(tmpPath, exclusiveWriteFlags(), 0o600);
    tempCreated = true;
    await fh.writeFile(normalized, "utf8");
    // tmp は書込中 0600 のまま保ち、内容が完成してから既存ファイルの
    // permission bits を復元する。rename 後も共有マウントの権限を維持する。
    if (destinationMode !== null) {
      await fh.chmod(destinationMode);
    }
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tmpPath, absPath);
    await syncParentDirectory(parent);
  } finally {
    await fh?.close().catch(() => undefined);
    // Do not remove a path we failed to create: it may be an attacker-owned
    // symlink that caused O_EXCL to reject the open.
    if (tempCreated) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}

/** mtime を ISO 8601（RFC3339 相当）文字列で返す。Rust `file_mtime_iso`。 */
export async function fileMtimeIso(absPath: string): Promise<string> {
  const meta = await stat(absPath);
  return meta.mtime.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// scan（Rust external_mount::scan）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `root` を再帰スキャンして `.md` ファイルと中間ディレクトリを収集する。
 * symlink は非追従（Rust `follow_links = false`）。深さ / 件数 / バイト上限で
 * DoS を弾く。Rust `scan_root` の忠実移植（rel_path 昇順ソート）。
 */
export async function scanRoot(root: string): Promise<ScanResult> {
  const canonicalRoot = await realpath(root);
  const dirs: ScannedDir[] = [];
  const files: ScannedFile[] = [];
  const visited = new Set<string>();
  const counters = { totalBytes: 0 };
  await walk(canonicalRoot, canonicalRoot, 0, visited, dirs, files, counters);
  dirs.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  files.sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return { dirs, files };
}

async function walk(
  root: string,
  current: string,
  depth: number,
  visited: Set<string>,
  dirs: ScannedDir[],
  files: ScannedFile[],
  counters: { totalBytes: number },
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    throw new Error(
      `scan depth exceeded maximum of ${MAX_SCAN_DEPTH} at ${current}`,
    );
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    // symlink は追従しない（Dirent は link 自体を指すため isDirectory/isFile は false）。
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      // symlink 非追従下では再訪は起こり得ないが、Rust に倣い防御的に visited 判定。
      if (visited.has(abs)) continue;
      visited.add(abs);
      const rel = normalizeRelPath(path.relative(root, abs));
      if (rel !== "") {
        dirs.push({ name: entry.name, relPath: rel });
      }
      await walk(root, abs, depth + 1, visited, dirs, files, counters);
    } else if (entry.isFile()) {
      if (path.extname(entry.name) !== ".md") continue;
      // 件数上限（攻撃者フォルダの大量 .md でメモリ枯渇 → renderer 転送 DoS を防ぐ）。
      if (files.length >= MAX_SCAN_FILES) {
        throw new Error(
          `scan exceeded maximum of ${MAX_SCAN_FILES} markdown files`,
        );
      }
      const rel = normalizeRelPath(path.relative(root, abs));
      // oversize / 読込失敗の 1 ファイルで scan 全体を落とさず skip + warn。
      let content: string;
      try {
        content = await readTextFile(abs);
      } catch (e) {
        console.warn(
          `[external-mount] skipping unreadable file during scan: ${abs} (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
        continue;
      }
      counters.totalBytes += Buffer.byteLength(content, "utf8");
      if (counters.totalBytes > MAX_SCAN_TOTAL_BYTES) {
        throw new Error(
          `scan exceeded cumulative size limit of ${MAX_SCAN_TOTAL_BYTES / (1024 * 1024)} MiB`,
        );
      }
      const mtime = await fileMtimeIso(abs);
      files.push({
        relPath: rel,
        content,
        mtime,
        contentHash: contentHash(content),
      });
    }
  }
}
