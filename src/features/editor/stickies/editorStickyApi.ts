import { invoke } from "@/lib/tauri";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";
import { DEFAULT_COLOR_SLOT, DEFAULT_PALETTE_ID } from "@/lib/stickyPalettes";
import {
  EMPTY_STICKY_BODY,
  type EditorSticky,
  type EditorStickyPatch,
} from "./editorStickyTypes";

export interface CreateEditorStickyInput {
  projectId: string;
  documentKey: DocumentKey;
  body?: string;
  paletteId?: string;
  colorSlot?: number;
  inlineOffset: number;
  blockOffset: number;
  zIndex?: number;
}

interface EditorStickyWire {
  id: string;
  projectId: string;
  documentKey: string;
  body: string;
  paletteId: string;
  colorSlot: number;
  inlineOffset: number;
  blockOffset: number;
  zIndex: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class EditorStickyConflictError extends Error {
  readonly stickyId: string;
  readonly expectedVersion: number;

  constructor(stickyId: string, expectedVersion: number) {
    super(
      `Editor sticky ${stickyId} changed before version ${expectedVersion}`,
    );
    this.name = "EditorStickyConflictError";
    this.stickyId = stickyId;
    this.expectedVersion = expectedVersion;
  }
}

function decodeDocumentKey(encoded: string): DocumentKey {
  if (encoded.startsWith("tree:database:")) {
    return {
      kind: "tree",
      storage: "database",
      id: decodeURIComponent(encoded.slice("tree:database:".length)),
    };
  }
  if (encoded.startsWith("tree:file:")) {
    return {
      kind: "tree",
      storage: "file",
      id: decodeURIComponent(encoded.slice("tree:file:".length)),
    };
  }
  if (encoded.startsWith("codex:")) {
    const [, id, ...modeParts] = encoded.split(":");
    const mode = modeParts.join(":");
    return {
      kind: "codex",
      id: decodeURIComponent(id ?? ""),
      phaseId:
        mode === "base"
          ? null
          : decodeURIComponent(mode.slice("phase:".length)),
    };
  }
  if (encoded.startsWith("snippet:")) {
    return {
      kind: "snippet",
      id: decodeURIComponent(encoded.slice("snippet:".length)),
    };
  }
  if (encoded.startsWith("chronicle-event:")) {
    return {
      kind: "chronicle-event",
      id: decodeURIComponent(encoded.slice("chronicle-event:".length)),
    };
  }
  throw new Error(`Unsupported editor sticky document key: ${encoded}`);
}

function toEditorSticky(row: EditorStickyWire): EditorSticky {
  return {
    id: row.id,
    projectId: row.projectId,
    documentKey: decodeDocumentKey(row.documentKey),
    body: row.body,
    paletteId: row.paletteId,
    colorSlot: row.colorSlot,
    inlineOffset: row.inlineOffset,
    blockOffset: row.blockOffset,
    zIndex: row.zIndex,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function throwConflictIfNeeded(
  error: unknown,
  stickyId: string,
  expectedVersion: number,
): never {
  if (
    String(error).includes(
      `EDITOR_STICKY_CONFLICT:${stickyId}:${expectedVersion}`,
    )
  ) {
    throw new EditorStickyConflictError(stickyId, expectedVersion);
  }
  throw error;
}

export async function listEditorStickies(
  projectId: string,
  documentKey: DocumentKey,
): Promise<EditorSticky[]> {
  const rows = await invoke<EditorStickyWire[]>("editor_sticky_list", {
    projectId,
    documentKey: encodeDocumentKey(documentKey),
  });
  return rows.map(toEditorSticky);
}

export async function createEditorSticky(
  input: CreateEditorStickyInput,
): Promise<EditorSticky> {
  const row = await invoke<EditorStickyWire>("editor_sticky_create", {
    payload: {
      projectId: input.projectId,
      documentKey: encodeDocumentKey(input.documentKey),
      body: input.body ?? EMPTY_STICKY_BODY,
      paletteId: input.paletteId ?? DEFAULT_PALETTE_ID,
      colorSlot: input.colorSlot ?? DEFAULT_COLOR_SLOT,
      inlineOffset: input.inlineOffset,
      blockOffset: input.blockOffset,
      zIndex: input.zIndex ?? 0,
    },
  });
  return toEditorSticky(row);
}

export async function updateEditorSticky(
  projectId: string,
  stickyId: string,
  patch: EditorStickyPatch,
  baseVersion: number,
): Promise<EditorSticky> {
  try {
    const row = await invoke<EditorStickyWire>("editor_sticky_update", {
      payload: { projectId, stickyId, patch, baseVersion },
    });
    return toEditorSticky(row);
  } catch (error) {
    throwConflictIfNeeded(error, stickyId, baseVersion);
  }
}

export async function deleteEditorSticky(
  projectId: string,
  stickyId: string,
  baseVersion: number,
): Promise<void> {
  try {
    await invoke("editor_sticky_delete", {
      payload: { projectId, stickyId, baseVersion },
    });
  } catch (error) {
    throwConflictIfNeeded(error, stickyId, baseVersion);
  }
}
