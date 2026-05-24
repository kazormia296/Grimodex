/**
 * Recursively collect `.md`/`.markdown` files under a directory tree.
 *
 * Designed to mirror the safety bounds of the Rust scanner
 * (`src-tauri/src/external_mount/scan.rs`):
 *   - hard depth cap so a pathological tree cannot blow the call stack
 *   - symlinks are skipped, which is the simplest way to prevent cycles
 *     when the host filesystem allows them (e.g. a hostile archive
 *     containing `a -> ../`).
 *
 * The Tauri plugin-fs primitives are injected so the loop is testable in
 * vitest without a real filesystem.
 */

export const MAX_FOLDER_DEPTH = 64;

export interface FolderEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface FolderReaderFns {
  readDir(path: string): Promise<FolderEntry[]>;
  readTextFile(path: string): Promise<string>;
}

export interface CollectedFile {
  relPath: string;
  content: string;
}

export async function collectMarkdownFromDir(
  dirPath: string,
  basePath: string,
  fns: FolderReaderFns,
  depth = 0,
): Promise<CollectedFile[]> {
  if (depth > MAX_FOLDER_DEPTH) {
    throw new Error(
      `directory depth exceeded ${MAX_FOLDER_DEPTH} at ${dirPath}`,
    );
  }
  const entries = await fns.readDir(dirPath);
  const files: CollectedFile[] = [];

  for (const entry of entries) {
    // Match scan.rs: do not follow symlinks. This both prevents cycles
    // (`a -> ../`) and avoids accidentally walking outside the picked
    // folder via a symlink to elsewhere on disk.
    if (entry.isSymlink) continue;

    const fullPath = `${dirPath}/${entry.name}`.replace(/\/+/g, "/");
    if (entry.isDirectory) {
      files.push(
        ...(await collectMarkdownFromDir(fullPath, basePath, fns, depth + 1)),
      );
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".markdown")) {
      const content = await fns.readTextFile(fullPath);
      const relPath = fullPath.slice(basePath.length + 1);
      files.push({ relPath, content });
    }
  }
  return files;
}
