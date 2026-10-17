/**
 * profile data directory の保護（K3/2 SF-1。DA-1）。
 *
 * 状態ファイル（`profile-egress.json`）、`license.json`、設定、AI key の暗号文、
 * packaged の Linux の MCP sidecar の実行 file を持つ `app.getPath("userData")` に、
 * 画面（renderer。乗っ取られたものを含む）が渡す path で届かないようにする。
 * 対象は、renderer が渡す値で書く file の path が決まる経路:
 * - 外部 folder の mount の root と対象（externalMount.ts）
 * - 保存 dialog の返却 path（shellCommands.ts の showSavePathDialog）
 * - Chromium の download の保存先（downloadGuard.ts）
 *
 * 比較は canonical path と file の identity（device と inode）の両方で行う。
 * 対象の最も近い既存の祖先まで realpath し、祖先の鎖の identity に
 * profile data directory の identity があるかを見る。大文字小文字を区別しない
 * file system、Windows の短縮名、junction、bind mount、profile data directory
 * 自体が symlink の場合も成り立つ。解決できないときは拒否する（fail closed）。
 * inode が 0 の volume は identity を使わず canonical path の比較だけにする。
 * profile data directory は呼出しごとに解決し直す（cache しない）。
 *
 * このモジュールは electron に依存しない（vitest の node 環境で単体試験する）。
 * 既定の guard（`app.getPath("userData")`）は profileDataGuardDefault.ts。
 */
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** 平文と path を含まない typed な拒否の理由。 */
export const PROFILE_DATA_GUARD_ERROR_CODE = "PROFILE_DATA_DIR_REJECTED";

export type ProfileDataGuardReason =
  | "inside-profile-data-directory"
  | "overlaps-profile-data-directory"
  | "unresolvable";

export class ProfileDataGuardError extends Error {
  readonly code = PROFILE_DATA_GUARD_ERROR_CODE;
  constructor(readonly reason: ProfileDataGuardReason) {
    super(
      `${PROFILE_DATA_GUARD_ERROR_CODE}: ${reason} (the profile data directory is not reachable from the app screen)`,
    );
    this.name = "ProfileDataGuardError";
  }
}

export interface ProfileDataGuard {
  /**
   * `target`（存在しなくてもよい）の実体が profile data directory の中にあれば
   * 拒否する。解決できないときも拒否する。
   */
  assertOutside(target: string): Promise<void>;
  /**
   * mount の root の実体が profile data directory と等しい、含む、含まれる
   * のどれかなら拒否する。解決できないときも拒否する。
   */
  assertNoOverlap(root: string): Promise<void>;
}

interface Identity {
  dev: bigint;
  ino: bigint;
}

interface ResolvedPath {
  /** 実体の絶対 path。存在しない末尾の名前は祖先の実体に付けたもの。 */
  canonical: string;
  /** 実在する最も近い祖先（または自身）の実体。 */
  base: string;
}

function unresolvable(): ProfileDataGuardError {
  return new ProfileDataGuardError("unresolvable");
}

/** 大文字小文字を区別しない platform か（canonical path の比較にだけ使う）。 */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * `child` が `parent` と等しい、またはその下にあるか（canonical 同士の比較）。
 * 境界安全（`/root2` は `/root` の下ではない）。
 */
export function isInsideCanonicalPath(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string): string => {
    const resolved = pathApi.resolve(value);
    return foldsCase(platform) ? resolved.toLowerCase() : resolved;
  };
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  const withSep = p.endsWith(pathApi.sep) ? p : p + pathApi.sep;
  return c.startsWith(withSep);
}

function hasParentSegment(target: string): boolean {
  return target.split(/[\\/]/).some((segment) => segment === "..");
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * symlink と junction を解決した実体の path を返す。存在しない末尾の名前は
 * 最も近い既存の祖先の実体に付ける。解決できないとき（絶対 path でない、`..` を
 * 含む、ENOENT 以外の error、dangling symlink）は拒否する。
 */
async function resolveCanonical(target: string): Promise<ResolvedPath> {
  if (
    typeof target !== "string" ||
    target.length === 0 ||
    target.includes("\0") ||
    !path.isAbsolute(target) ||
    hasParentSegment(target)
  ) {
    throw unresolvable();
  }
  let probe = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(probe);
      return {
        canonical: rest.length > 0 ? path.join(real, ...rest.reverse()) : real,
        base: real,
      };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw unresolvable();
      // 存在しない名前が dangling symlink なら、書込みは symlink の先に作られる。
      try {
        const meta = await lstat(probe);
        if (meta.isSymbolicLink()) throw unresolvable();
      } catch (lstatError) {
        if (lstatError instanceof ProfileDataGuardError) throw lstatError;
        if (errorCode(lstatError) !== "ENOENT") throw unresolvable();
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw unresolvable();
      rest.push(path.basename(probe));
      probe = parent;
    }
  }
}

async function identityOf(target: string): Promise<Identity | null> {
  const meta = await stat(target, { bigint: true });
  // inode を持たない volume は identity として使わない。
  if (meta.ino === 0n) return null;
  return { dev: meta.dev, ino: meta.ino };
}

function sameIdentity(a: Identity | null, b: Identity | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

/** `base`（実在する実体）から root までの祖先（自身を含む）の identity。 */
async function ancestorIdentities(
  base: string,
): Promise<Array<Identity | null>> {
  const chain: Array<Identity | null> = [];
  let current = base;
  for (;;) {
    chain.push(await identityOf(current));
    const parent = path.dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

export interface ProfileDataGuardOptions {
  platform?: NodeJS.Platform;
}

/**
 * `getProfileDataDir` は呼出しごとに profile data directory の path を返す
 * （Native の `appDataDir` に渡す `app.getPath("userData")`）。
 */
export function createProfileDataGuard(
  getProfileDataDir: () => string,
  options: ProfileDataGuardOptions = {},
): ProfileDataGuard {
  const platform = options.platform ?? process.platform;

  async function resolveProfile(): Promise<{
    canonical: string;
    identity: Identity | null;
    ancestors: Array<Identity | null>;
  }> {
    let dir: string;
    try {
      dir = getProfileDataDir();
    } catch {
      throw unresolvable();
    }
    const resolved = await resolveCanonical(dir).catch(() => {
      throw unresolvable();
    });
    // profile data directory は存在しなければならない。
    if (resolved.canonical !== resolved.base) throw unresolvable();
    try {
      const ancestors = await ancestorIdentities(resolved.base);
      return {
        canonical: resolved.canonical,
        identity: ancestors[0] ?? null,
        ancestors,
      };
    } catch {
      throw unresolvable();
    }
  }

  async function resolveTarget(target: string): Promise<{
    resolved: ResolvedPath;
    ancestors: Array<Identity | null>;
  }> {
    const resolved = await resolveCanonical(target);
    try {
      return { resolved, ancestors: await ancestorIdentities(resolved.base) };
    } catch {
      throw unresolvable();
    }
  }

  return {
    async assertOutside(target: string): Promise<void> {
      const profile = await resolveProfile();
      const { resolved, ancestors } = await resolveTarget(target);
      if (
        isInsideCanonicalPath(
          resolved.canonical,
          profile.canonical,
          platform,
        ) ||
        ancestors.some((id) => sameIdentity(id, profile.identity))
      ) {
        throw new ProfileDataGuardError("inside-profile-data-directory");
      }
    },
    async assertNoOverlap(root: string): Promise<void> {
      const profile = await resolveProfile();
      const { resolved, ancestors } = await resolveTarget(root);
      const rootIdentity = ancestors[0] ?? null;
      if (
        // root が profile data directory と等しい、または中にある。
        isInsideCanonicalPath(
          resolved.canonical,
          profile.canonical,
          platform,
        ) ||
        ancestors.some((id) => sameIdentity(id, profile.identity)) ||
        // root が profile data directory を含む。
        isInsideCanonicalPath(
          profile.canonical,
          resolved.canonical,
          platform,
        ) ||
        profile.ancestors.some(
          (id) => rootIdentity !== null && sameIdentity(id, rootIdentity),
        )
      ) {
        throw new ProfileDataGuardError("overlaps-profile-data-directory");
      }
    },
  };
}
