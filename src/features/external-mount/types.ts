export interface ExternalRoot {
  id: string;
  path: string;
  label: string;
}

export const EXTERNAL_ROOTS_KEY = "external.roots";

export type FileEventKind = "changed" | "added" | "removed" | "renamed";

export interface FileEvent {
  rootId: string;
  relPath: string;
  oldRelPath?: string | null;
  kind: FileEventKind;
}

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

export interface ReloadConflictState {
  sceneId: string;
  rootId: string;
  relPath: string;
  incomingContent: string;
  incomingMtime: string;
}
