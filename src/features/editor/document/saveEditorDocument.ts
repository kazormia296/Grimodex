import { DOMSerializer } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { uiUpdateEvent } from "@/features/agent-writes/event";
import { persistSceneBody } from "@/features/editor/persistSceneBody";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { AlreadyNotifiedSaveError } from "./saveErrors";
import type { LoadedEditorBinding } from "./types";

export interface EditorDocumentServices {
  persistSceneBody: (id: string, doc: ProseMirrorNode) => Promise<void>;
  updateCodexPhase: (
    phaseId: string,
    data: { contentOverride: string },
  ) => Promise<void>;
  updateCodexText: (id: string, data: { content: string }) => Promise<void>;
  updateSnippet: (id: string, data: { content: string }) => Promise<boolean>;
  updateChronicleEvent: (input: {
    eventId: string;
    detail: string;
  }) => Promise<void>;
  serializeSnippet: (doc: ProseMirrorNode) => string;
}

/** Serialize with the same ProseMirror schema used by the live editor. */
export function serializeSnippet(doc: ProseMirrorNode): string {
  if (typeof document === "undefined") {
    throw new Error("snippet serialization requires a DOM document");
  }
  const container = document.createElement("div");
  const fragment = DOMSerializer.fromSchema(doc.type.schema).serializeFragment(
    doc.content,
    { document },
  );
  container.appendChild(fragment);
  return container.innerHTML;
}

export const defaultEditorDocumentServices: EditorDocumentServices = {
  persistSceneBody,
  updateCodexPhase: (phaseId, data) =>
    usePhaseStore.getState().updatePhase(phaseId, data),
  updateCodexText: (id, data) => useCodexStore.getState().updateText(id, data),
  updateSnippet: (id, data) => useSnippetStore.getState().update(id, data),
  updateChronicleEvent: uiUpdateEvent,
  serializeSnippet,
};

/**
 * Persist the document through the backend selected by the last successful
 * load. This function owns routing only; scene side effects remain in
 * persistSceneBody and store-level OCC/history behavior remains in each store.
 */
export async function saveEditorDocument(
  binding: LoadedEditorBinding,
  doc: ProseMirrorNode,
  services: EditorDocumentServices = defaultEditorDocumentServices,
): Promise<void> {
  switch (binding.kind) {
    case "tree":
      await services.persistSceneBody(binding.id, doc);
      return;

    case "codex": {
      const content = JSON.stringify(doc.toJSON());
      if (binding.phaseId) {
        await services.updateCodexPhase(binding.phaseId, {
          contentOverride: content,
        });
      } else {
        await services.updateCodexText(binding.id, { content });
      }
      return;
    }

    case "snippet": {
      const saved = await services.updateSnippet(binding.id, {
        content: services.serializeSnippet(doc),
      });
      if (!saved) {
        throw new AlreadyNotifiedSaveError(
          `snippet save not persisted: ${binding.id}`,
        );
      }
      return;
    }

    case "chronicle-event":
      await services.updateChronicleEvent({
        eventId: binding.id,
        detail: JSON.stringify(doc.toJSON()),
      });
      return;
  }
}
