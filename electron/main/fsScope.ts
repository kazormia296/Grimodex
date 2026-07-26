/**
 * fs ブリッジの実行時スコープ（Phase 3 — fs ブリッジのスコープ制限）。
 *
 * Phase 2 の fs ブリッジは renderer から任意パスを読めた。Tauri 側は
 * capabilities に fs 権限を置かず「dialog で選ばれたパスに runtime scope が
 * 付与される」plugin-dialog / plugin-fs の連動に依存しているため、Electron
 * でも同じ契約を写像する:
 *
 * - dialog.openFolder / openFile の成功 = ユーザーの明示的な許可とみなし、
 *   そのパス（フォルダは配下再帰）をスコープへ登録する
 * - fs ブリッジ（readTextFile / readDir）はスコープ外パスを
 *   FS_SCOPE_DENIED マーカー付きエラーで拒否する
 * - スコープはプロセス内メモリのみ（Tauri の runtime scope と同じく
 *   再起動で消える。永続化しない）
 *
 * symlink 対策は二段階照合: まず「字面の正規化パス」で照合し、スコープ外なら
 * fs 呼び出しを一切せず拒否する（スコープ外パスの存在有無を漏らさない）。
 * 字面で in-scope でも realpath 後に再照合し、スコープ内に置かれた symlink が
 * スコープ外の実体を指すエスケープを塞ぐ。grant 側も「選ばれた字面」と
 * 「realpath」の両方を登録する（/tmp → /private/tmp のような OS 由来の
 * symlink 越しでも、renderer が dialog の返り値をそのまま join して使える）。
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

export const FS_SCOPE_DENIED_MARKER = "FS_SCOPE_DENIED:";

export function fsScopeDeniedError(target: string): string {
  return `${FS_SCOPE_DENIED_MARKER} path is outside the dialog-granted scope: ${target}`;
}

/**
 * target が dir 配下（dir 自身を含む）かの純粋判定。単純な文字列前方一致だと
 * `/foo/bar` が `/foo/barbaz` を含んでしまうため path.relative で判定する
 * （win32 の大文字小文字差も path.relative が吸収する）。
 */
export function isWithinDir(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  if (rel === "") return true;
  return (
    rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

/** 照合モード: readTextFile は単一ファイル grant も許す。readDir は dir grant のみ。 */
export interface ScopeCheckOptions {
  asFile: boolean;
}

export class FsScope {
  /** dialog.openFile で選ばれた単一ファイル（字面 + realpath）。 */
  private readonly files = new Set<string>();
  /** file grant 時点の lexical parent → canonical parent 対応。 */
  private readonly fileAliasRoots: Array<{
    lexical: string;
    canonical: string;
  }> = [];
  /** dialog.openFolder で選ばれたフォルダ（字面 + realpath、配下再帰）。 */
  private readonly dirs = new Set<string>();

  /** dialog.openFile 成功時に呼ぶ。ダイアログの返り値は実在パス前提。 */
  async allowFile(picked: string): Promise<void> {
    const lexical = path.resolve(picked);
    const real = await realpath(lexical);
    this.files.add(lexical);
    this.files.add(real);

    const lexicalParent = path.dirname(lexical);
    this.fileAliasRoots.push({
      lexical: lexicalParent,
      canonical: await realpath(lexicalParent),
    });
  }

  /** dialog.openFolder 成功時に呼ぶ。 */
  async allowDir(picked: string): Promise<void> {
    this.dirs.add(path.resolve(picked));
    this.dirs.add(await realpath(picked));
  }

  private contains(target: string, opts: ScopeCheckOptions): boolean {
    if (opts.asFile) {
      if (this.files.has(target)) return true;
      // macOS の /var -> /private/var のように、picked の親自体が OS
      // 由来の alias である場合がある。grant 時に確定した親同士の対応で
      // target を写像し、選択済みの同一実体だけを許可する。
      for (const roots of this.fileAliasRoots) {
        if (!isWithinDir(roots.lexical, target)) continue;
        const mapped = path.resolve(
          roots.canonical,
          path.relative(roots.lexical, target),
        );
        if (this.files.has(mapped)) return true;
      }
    }
    for (const dir of this.dirs) {
      if (isWithinDir(dir, target)) return true;
    }
    return false;
  }

  /**
   * 読み取り対象パスを検証し、実体パス（realpath）を返す。スコープ外は
   * FS_SCOPE_DENIED で reject する。字面照合 → realpath → 再照合の順で、
   * スコープ外パスには fs syscall を発行しない（ENOENT との出し分けで
   * 任意パスの存在有無が漏れるのを防ぐ）。in-scope の不存在パスは従来どおり
   * ENOENT がそのまま伝播する。
   */
  async assertReadable(
    requested: string,
    opts: ScopeCheckOptions,
  ): Promise<string> {
    const normalized = path.resolve(requested);
    if (!this.contains(normalized, opts)) {
      throw new Error(fsScopeDeniedError(requested));
    }
    const real = await realpath(normalized);
    if (!this.contains(real, opts)) {
      throw new Error(fsScopeDeniedError(requested));
    }
    return real;
  }
}
