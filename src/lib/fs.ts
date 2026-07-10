import { isTauri } from "./tauri";

/**
 * ファイル読み取りの抽象層（@tauri-apps/plugin-fs の中央ラッパー）。
 * 現に使われている readTextFile / readDir のみラップする。
 *
 * 非 Tauri 環境では従来（plugin 直呼び）と同じく reject する。
 */

/** plugin-fs の DirEntry と構造互換（markdownFolderReader の FolderEntry と同形）。 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

function assertTauri(): void {
  if (!isTauri()) {
    throw new Error("fs is unavailable outside the Tauri runtime");
  }
}

export async function readTextFile(path: string): Promise<string> {
  assertTauri();
  const { readTextFile: tauriReadTextFile } =
    await import("@tauri-apps/plugin-fs");
  return tauriReadTextFile(path);
}

export async function readDir(path: string): Promise<DirEntry[]> {
  assertTauri();
  const { readDir: tauriReadDir } = await import("@tauri-apps/plugin-fs");
  return tauriReadDir(path);
}
