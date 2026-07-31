import type { TabContentType } from "@/features/editor/tabStore";

/**
 * The document a surface intends to show. This is deliberately separate from
 * LoadedEditorBinding: a target may fail to load and must not become a save
 * target until its content has been applied successfully.
 */
export type EditorDocumentTarget =
  | {
      kind: "tree";
      id: string;
      nodeType: "scene" | "note";
      storage: "database" | "file";
    }
  | {
      kind: "codex";
      id: string;
      phase:
        | { mode: "base" }
        | { mode: "explicit"; phaseId: string }
        | { mode: "auto"; sceneId: string | null };
    }
  | { kind: "snippet"; id: string }
  | { kind: "chronicle-event"; id: string };

/**
 * The document that is actually present in the editor and is therefore safe
 * to persist. Keep this as one discriminated value so id, kind, and phase
 * identity cannot drift apart between saves.
 */
export type EditorDocumentIdentity =
  | {
      kind: "tree";
      id: string;
      nodeType: "scene" | "note";
      storage: "database" | "file";
    }
  | { kind: "codex"; id: string; phaseId: string | null }
  | { kind: "snippet"; id: string }
  | { kind: "chronicle-event"; id: string };

export type LoadedEditorBinding =
  | (Extract<EditorDocumentIdentity, { kind: "tree" }> & {
      loadedVersion: number;
    })
  | (Extract<EditorDocumentIdentity, { kind: "codex" }> & {
      loadedVersion: number;
    })
  | (Extract<EditorDocumentIdentity, { kind: "snippet" }> & {
      loadedVersion: number;
    })
  | (Extract<EditorDocumentIdentity, { kind: "chronicle-event" }> & {
      loadedVersion: number;
    });

export type EditorDocumentContent = string | Record<string, unknown>;

export interface LoadedEditorDocument {
  /** Candidate binding; the session commits it only after setContent succeeds. */
  binding: LoadedEditorBinding;
  content: EditorDocumentContent;
  title?: string;
  unplacedBeatsDoc?: string;
}

/** Build the loaded binding for the current tab after its content is applied. */
export function createLoadedEditorBinding(
  contentType: TabContentType,
  id: string,
  tree?: { nodeType: "scene" | "note"; storage: "database" | "file" },
  phaseId: string | null = null,
  loadedVersion = 0,
): LoadedEditorBinding {
  switch (contentType) {
    case "codex":
      return { kind: "codex", id, phaseId, loadedVersion };
    case "snippet":
      return { kind: "snippet", id, loadedVersion };
    case "chronicle_event":
      return { kind: "chronicle-event", id, loadedVersion };
    case "scene":
      return {
        kind: "tree",
        id,
        nodeType: tree?.nodeType ?? "scene",
        storage: tree?.storage ?? "database",
        loadedVersion,
      };
  }
}
