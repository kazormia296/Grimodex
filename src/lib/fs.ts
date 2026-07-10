import { electronBridge, isElectron } from "./shell";
import { isTauri } from "./tauri";

/**
 * ファイル読み取りの抽象層（@tauri-apps/plugin-fs の中央ラッパー）。
 * 現に使われている readTextFile / readDir のみラップする。
 *
 * Electron シェルでは main プロセスの fs ブリッジ（window.grimodex.fs）を
 * 経由する。それ以外の非 Tauri 環境では従来（plugin 直呼び）と同じく
 * reject する。
 */

/** plugin-fs の DirEntry と構造互換（markdownFolderReader の FolderEntry と同形）。 */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export async function readTextFile(path: string): Promise<string> {
  if (isTauri()) {
    const { readTextFile: tauriReadTextFile } =
      await import("@tauri-apps/plugin-fs");
    return tauriReadTextFile(path);
  }
  if (isElectron()) {
    return electronBridge().fs.readTextFile(path);
  }
  throw new Error("fs is unavailable outside the Tauri runtime");
}

export async function readDir(path: string): Promise<DirEntry[]> {
  if (isTauri()) {
    const { readDir: tauriReadDir } = await import("@tauri-apps/plugin-fs");
    return tauriReadDir(path);
  }
  if (isElectron()) {
    return electronBridge().fs.readDir(path);
  }
  throw new Error("fs is unavailable outside the Tauri runtime");
}
