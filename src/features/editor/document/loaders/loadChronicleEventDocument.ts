import * as chronicleApi from "@/features/chronicle/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import type { LoadedEditorBinding, LoadedEditorDocument } from "../types";

export interface ChronicleEventDocumentLoadServices {
  getEvent: (
    projectId: string,
    id: string,
  ) => Promise<
    { title?: string | null; detail?: string | null } | null | undefined
  >;
  getCurrentProjectId: () => string;
}

const defaultChronicleEventDocumentLoadServices: ChronicleEventDocumentLoadServices =
  {
    getEvent: (projectId, id) => chronicleApi.getEvent(projectId, id),
    getCurrentProjectId,
  };

export async function loadChronicleEventDocument(
  binding: Extract<LoadedEditorBinding, { kind: "chronicle-event" }>,
  services: ChronicleEventDocumentLoadServices = defaultChronicleEventDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  const event = await services.getEvent(
    services.getCurrentProjectId(),
    binding.id,
  );
  return {
    binding,
    content: tiptapContentFromDb(event?.detail),
    title: event?.title ?? "",
  };
}
