import { DOMSerializer } from "@tiptap/pm/model";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { uiUpdateEvent } from "@/features/agent-writes/event";
import {
  persistSceneBody,
  type PersistedSceneBody,
} from "@/features/editor/persistSceneBody";
import { useCodexStore } from "@/features/codex/codexStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import type { VersionedSaveOutcome } from "@/lib/saveOutcome";
import type { AgentWriteResult } from "@/features/agent-writes/event";
import { AlreadyNotifiedSaveError } from "./saveErrors";
import type { LoadedEditorBinding } from "./types";
import type { TimelapseDocumentRef } from "@/features/timelapse/documentCoverage";
import type { TimelapseDocumentIdentity } from "@/features/timelapse/bodyWriteMode";

export interface TimelapseDocumentSaveOptions {
  /** Accepted doc.step capability from the loaded editor session. */
  timelapseDocument?: TimelapseDocumentRef;
  /** Structural identity used by replacement fallback. */
  timelapseDocumentIdentity?: TimelapseDocumentIdentity;
  /** Draft admitted before a lifecycle lease began draining autosaves. */
  preexistingDraft?: boolean;
}

export interface EditorDocumentServices {
  persistSceneBody: (
    id: string,
    doc: ProseMirrorNode,
    options: {
      baseVersion: number;
      timelapseDocument?: TimelapseDocumentRef;
      timelapseDocumentIdentity?: TimelapseDocumentIdentity;
      preexistingDraft?: boolean;
    },
  ) => Promise<PersistedSceneBody>;
  updateCodexPhase: (
    phaseId: string,
    data: { contentOverride: string },
    options: {
      baseVersion: number;
      timelapseDocument?: TimelapseDocumentRef;
      preexistingDraft?: boolean;
    },
  ) => Promise<CodexEntryPhase | null>;
  updateCodexText: (
    id: string,
    data: { content: string },
    options: {
      baseVersion: number;
      timelapseDocument?: TimelapseDocumentRef;
      preexistingDraft?: boolean;
    },
  ) => Promise<VersionedSaveOutcome>;
  updateSnippet: (
    id: string,
    data: { content: string },
    options: {
      baseVersion: number;
      timelapseDocument?: TimelapseDocumentRef;
      preexistingDraft?: boolean;
    },
  ) => Promise<VersionedSaveOutcome>;
  updateChronicleEvent: (
    input: {
      eventId: string;
      detail: string;
      baseVersion: number;
    },
    options?: { preexistingDraft?: boolean },
  ) => Promise<AgentWriteResult>;
  serializeSnippet: (doc: ProseMirrorNode) => string;
}

export interface SaveEditorDocumentResult {
  binding: LoadedEditorBinding;
  persistedSceneBody?: PersistedSceneBody;
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
  updateCodexPhase: (phaseId, data, options) =>
    usePhaseStore.getState().updatePhase(phaseId, data, options),
  updateCodexText: (id, data, options) =>
    useCodexStore.getState().updateText(id, data, options),
  updateSnippet: (id, data, options) =>
    useSnippetStore.getState().update(id, data, options),
  // This editor session advances its own loadedVersion from the returned
  // result; notifying it as an external writer would create a self-conflict.
  updateChronicleEvent: (input, options) =>
    uiUpdateEvent(input, {
      suppressDocumentNotification: true,
      ...(options?.preexistingDraft ? { preexistingDraft: true } : {}),
    }),
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
  timelapseOptions: TimelapseDocumentSaveOptions = {},
): Promise<SaveEditorDocumentResult> {
  switch (binding.kind) {
    case "tree": {
      const persistedSceneBody = await services.persistSceneBody(
        binding.id,
        doc,
        {
          baseVersion: binding.loadedVersion,
          ...timelapseOptions,
        },
      );
      return {
        binding: {
          ...binding,
          loadedVersion: persistedSceneBody.contentVersion,
        },
        persistedSceneBody,
      };
    }

    case "codex": {
      const content = JSON.stringify(doc.toJSON());
      if (binding.phaseId) {
        const updated = await services.updateCodexPhase(
          binding.phaseId,
          { contentOverride: content },
          {
            baseVersion: binding.loadedVersion,
            ...(timelapseOptions.preexistingDraft
              ? { preexistingDraft: true }
              : {}),
          },
        );
        if (!updated) {
          throw new AlreadyNotifiedSaveError(
            `Codex phase save not persisted: ${binding.phaseId}`,
          );
        }
        return {
          binding: { ...binding, loadedVersion: updated.version },
        };
      } else {
        const outcome = await services.updateCodexText(
          binding.id,
          { content },
          {
            baseVersion: binding.loadedVersion,
            ...(timelapseOptions.timelapseDocument
              ? { timelapseDocument: timelapseOptions.timelapseDocument }
              : {}),
            ...(timelapseOptions.preexistingDraft
              ? { preexistingDraft: true }
              : {}),
          },
        );
        if (!outcome.persisted) {
          throw new AlreadyNotifiedSaveError(
            `Codex save not persisted: ${binding.id}`,
          );
        }
        return {
          binding: { ...binding, loadedVersion: outcome.version },
        };
      }
    }

    case "snippet": {
      const outcome = await services.updateSnippet(
        binding.id,
        { content: services.serializeSnippet(doc) },
        {
          baseVersion: binding.loadedVersion,
          ...(timelapseOptions.timelapseDocument
            ? { timelapseDocument: timelapseOptions.timelapseDocument }
            : {}),
          ...(timelapseOptions.preexistingDraft
            ? { preexistingDraft: true }
            : {}),
        },
      );
      if (!outcome.persisted) {
        throw new AlreadyNotifiedSaveError(
          `snippet save not persisted: ${binding.id}`,
        );
      }
      return {
        binding: { ...binding, loadedVersion: outcome.version },
      };
    }

    case "chronicle-event": {
      const input = {
        eventId: binding.id,
        detail: JSON.stringify(doc.toJSON()),
        baseVersion: binding.loadedVersion,
      };
      const result = await (timelapseOptions.preexistingDraft
        ? services.updateChronicleEvent(input, { preexistingDraft: true })
        : services.updateChronicleEvent(input));
      return {
        binding: { ...binding, loadedVersion: result.version },
      };
    }
  }
}
