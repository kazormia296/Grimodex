import * as chronicleApi from "@/features/chronicle/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import type { EditorDocumentIdentity, LoadedEditorDocument } from "../types";

export interface ChronicleEventDocumentLoadServices {
  getEvent: (
    projectId: string,
    id: string,
  ) => Promise<
    | {
        title?: string | null;
        detail?: string | null;
        version: number;
      }
    | null
    | undefined
  >;
  getCurrentProjectId: () => string;
}

const defaultChronicleEventDocumentLoadServices: ChronicleEventDocumentLoadServices =
  {
    getEvent: (projectId, id) => chronicleApi.getEvent(projectId, id),
    getCurrentProjectId,
  };

export async function loadChronicleEventDocument(
  binding: Extract<EditorDocumentIdentity, { kind: "chronicle-event" }>,
  services: ChronicleEventDocumentLoadServices = defaultChronicleEventDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  const event = await services.getEvent(
    services.getCurrentProjectId(),
    binding.id,
  );
  if (!event) {
    throw new Error(`Chronicle Event '${binding.id}' was not found`);
  }
  return {
    binding: { ...binding, loadedVersion: event.version },
    content: tiptapContentFromDb(event.detail),
    title: event.title ?? "",
  };
}
