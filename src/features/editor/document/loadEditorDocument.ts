import type { TabContentType } from "@/features/editor/tabStore";
import { loadChronicleEventDocument } from "./loaders/loadChronicleEventDocument";
import {
  loadCodexDocument,
  type CodexDocumentLoadContext,
} from "./loaders/loadCodexDocument";
import { loadSnippetDocument } from "./loaders/loadSnippetDocument";
import { loadTreeDocument } from "./loaders/loadTreeDocument";
import type { EditorDocumentTarget, LoadedEditorDocument } from "./types";

export interface EditorDocumentLoadServices {
  tree?: Parameters<typeof loadTreeDocument>[1];
  codex?: Parameters<typeof loadCodexDocument>[2];
  snippet?: Parameters<typeof loadSnippetDocument>[1];
  chronicleEvent?: Parameters<typeof loadChronicleEventDocument>[1];
}

export interface LoadEditorDocumentOptions {
  codex?: CodexDocumentLoadContext;
  services?: EditorDocumentLoadServices;
}

/** Exhaustive document loader boundary used by the editor session. */
export async function loadEditorDocument(
  target: EditorDocumentTarget,
  options: LoadEditorDocumentOptions = {},
): Promise<LoadedEditorDocument> {
  const services = options.services;
  switch (target.kind) {
    case "tree":
      return loadTreeDocument(
        {
          kind: "tree",
          id: target.id,
          nodeType: target.nodeType,
          storage: target.storage,
        },
        services?.tree,
      );
    case "codex": {
      if (!options.codex) {
        throw new Error("Codex document loading requires phase context");
      }
      const binding = {
        kind: "codex" as const,
        id: target.id,
        phaseId: target.phase.mode === "explicit" ? target.phase.phaseId : null,
      };
      return loadCodexDocument(binding, options.codex, services?.codex);
    }
    case "snippet":
      return loadSnippetDocument(
        { kind: "snippet", id: target.id },
        services?.snippet,
      );
    case "chronicle-event":
      return loadChronicleEventDocument(
        { kind: "chronicle-event", id: target.id },
        services?.chronicleEvent,
      );
  }
}

export function targetFromTab(
  contentType: TabContentType,
  id: string,
  options?: {
    tree?: { nodeType: "scene" | "note"; storage: "database" | "file" };
    phaseIdOverride?: string | null;
    sceneId?: string | null;
  },
): EditorDocumentTarget {
  switch (contentType) {
    case "scene":
      return {
        kind: "tree",
        id,
        nodeType: options?.tree?.nodeType ?? "scene",
        storage: options?.tree?.storage ?? "database",
      };
    case "snippet":
      return { kind: "snippet", id };
    case "chronicle_event":
      return { kind: "chronicle-event", id };
    case "codex":
      return {
        kind: "codex",
        id,
        phase:
          options?.phaseIdOverride === "__base__"
            ? { mode: "base" }
            : options?.phaseIdOverride
              ? { mode: "explicit", phaseId: options.phaseIdOverride }
              : { mode: "auto", sceneId: options?.sceneId ?? null },
      };
  }
}
