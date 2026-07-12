import * as snippetsApi from "@/features/snippets/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import type { LoadedEditorBinding, LoadedEditorDocument } from "../types";

export interface SnippetDocumentLoadServices {
  getSnippet: (
    projectId: string,
    id: string,
  ) => Promise<{ content?: string | null } | undefined>;
  getCurrentProjectId: () => string;
}

const defaultSnippetDocumentLoadServices: SnippetDocumentLoadServices = {
  getSnippet: (projectId, id) => snippetsApi.getSnippet(projectId, id),
  getCurrentProjectId,
};

export async function loadSnippetDocument(
  binding: Extract<LoadedEditorBinding, { kind: "snippet" }>,
  services: SnippetDocumentLoadServices = defaultSnippetDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  const snippet = await services.getSnippet(
    services.getCurrentProjectId(),
    binding.id,
  );
  return {
    binding,
    content: tiptapContentFromDb(snippet?.content),
  };
}
