import * as snippetsApi from "@/features/snippets/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { tiptapContentFromDb } from "@/lib/prosemirror";
import type { EditorDocumentIdentity, LoadedEditorDocument } from "../types";

export interface SnippetDocumentLoadServices {
  getSnippet: (
    projectId: string,
    id: string,
  ) => Promise<{ content?: string | null; version: number } | undefined>;
  getCurrentProjectId: () => string;
}

const defaultSnippetDocumentLoadServices: SnippetDocumentLoadServices = {
  getSnippet: (projectId, id) => snippetsApi.getSnippet(projectId, id),
  getCurrentProjectId,
};

export async function loadSnippetDocument(
  binding: Extract<EditorDocumentIdentity, { kind: "snippet" }>,
  services: SnippetDocumentLoadServices = defaultSnippetDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  const snippet = await services.getSnippet(
    services.getCurrentProjectId(),
    binding.id,
  );
  if (!snippet) {
    throw new Error(`Snippet '${binding.id}' was not found`);
  }
  return {
    binding: { ...binding, loadedVersion: snippet.version },
    content: tiptapContentFromDb(snippet.content),
  };
}
