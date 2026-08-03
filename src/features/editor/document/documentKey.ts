import type { TabContentType } from "@/features/editor/tabStore";

/**
 * Canonical identity of an editor document.
 *
 * A tree node id is not sufficient for Codex because the base body and every
 * Phase body are independent persistence targets. Keep this value free of
 * mutable session state such as `loadedVersion` so it can safely key stores,
 * registries, and external-write notifications.
 */
export type DocumentKey =
  | {
      kind: "tree";
      id: string;
      storage: "database" | "file";
    }
  | { kind: "codex"; id: string; phaseId: string | null }
  | { kind: "snippet"; id: string }
  | { kind: "chronicle-event"; id: string };

export type EncodedDocumentKey = string & {
  readonly __encodedDocumentKey: unique symbol;
};

export type EditorInstanceId = string & {
  readonly __editorInstanceId: unique symbol;
};

type DocumentKeySource =
  | DocumentKey
  | {
      kind: "tree";
      id: string;
      nodeType: "scene" | "note";
      storage: "database" | "file";
    };

const encodePart = (value: string): string => encodeURIComponent(value);

/** Stable, collision-free string form used as an object/Map key. */
export function encodeDocumentKey(key: DocumentKeySource): EncodedDocumentKey {
  switch (key.kind) {
    case "tree":
      return `tree:${key.storage}:${encodePart(key.id)}` as EncodedDocumentKey;
    case "codex":
      return `codex:${encodePart(key.id)}:${
        key.phaseId === null ? "base" : `phase:${encodePart(key.phaseId)}`
      }` as EncodedDocumentKey;
    case "snippet":
      return `snippet:${encodePart(key.id)}` as EncodedDocumentKey;
    case "chronicle-event":
      return `chronicle-event:${encodePart(key.id)}` as EncodedDocumentKey;
  }
}

export function documentKeyFromBinding(
  binding: DocumentKeySource,
): DocumentKey {
  switch (binding.kind) {
    case "tree":
      return {
        kind: "tree",
        id: binding.id,
        storage: binding.storage,
      };
    case "codex":
      return {
        kind: "codex",
        id: binding.id,
        phaseId: binding.phaseId,
      };
    case "snippet":
      return { kind: "snippet", id: binding.id };
    case "chronicle-event":
      return { kind: "chronicle-event", id: binding.id };
  }
}

export function documentIdFromKey(key: DocumentKey): string {
  return key.id;
}

/**
 * Build the identity currently shown by an EditorPane. Codex `phaseId` must be
 * the resolved, successfully loaded Phase id rather than the tab's auto target.
 */
export function documentKeyForEditor(
  contentType: TabContentType,
  id: string,
  options?: {
    storage?: "database" | "file";
    phaseId?: string | null;
  },
): DocumentKey {
  switch (contentType) {
    case "scene":
      return {
        kind: "tree",
        id,
        storage: options?.storage ?? "database",
      };
    case "codex":
      return { kind: "codex", id, phaseId: options?.phaseId ?? null };
    case "snippet":
      return { kind: "snippet", id };
    case "chronicle_event":
      return { kind: "chronicle-event", id };
  }
}

let nextEditorInstance = 0;

/** Session-local identity. It is deliberately never persisted. */
export function createEditorInstanceId(prefix = "editor"): EditorInstanceId {
  nextEditorInstance += 1;
  return `${prefix}:${nextEditorInstance}` as EditorInstanceId;
}
