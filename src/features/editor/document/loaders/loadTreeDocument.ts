import * as treeApi from "@/features/tree/api";
import { markEnd, markStart } from "@/lib/perfLog";
import type {
  EditorDocumentContent,
  EditorDocumentIdentity,
  LoadedEditorDocument,
} from "../types";

export interface TreeDocumentLoadServices {
  loadSceneFull: (id: string) => Promise<{
    content: string;
    unplacedBeatsDoc: string;
    projectId?: string;
    version: number;
  }>;
}

const defaultTreeDocumentLoadServices: TreeDocumentLoadServices = {
  loadSceneFull: (id) => treeApi.loadSceneFull(id),
};

function parseTreeContent(raw: string): EditorDocumentContent {
  if (!raw || raw === "{}") return "";
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function loadTreeDocument(
  binding: Extract<EditorDocumentIdentity, { kind: "tree" }>,
  services: TreeDocumentLoadServices = defaultTreeDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  markStart("sceneLoad.loadSceneFull");
  const { content, unplacedBeatsDoc, projectId, version } =
    await services.loadSceneFull(binding.id);
  markEnd("sceneLoad.loadSceneFull");

  markStart(`sceneLoad.parseContent.scene.${content?.length ?? 0}`);
  const parsed = parseTreeContent(content);
  markEnd(`sceneLoad.parseContent.scene.${content?.length ?? 0}`);

  return {
    binding: { ...binding, loadedVersion: version },
    content: parsed,
    unplacedBeatsDoc,
    projectId,
  };
}
