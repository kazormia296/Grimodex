import { savePlacedBeatPreviewOnly } from "@/features/tree/api";
import type { LoadedEditorBinding } from "./document/types";

interface PlacedBeatPreviewBackfillServices {
  savePlacedBeatPreviewOnly: (
    sceneId: string,
    payload: {
      placedBeatPreview: string | null;
      projectId: string;
      baseVersion: number;
    },
  ) => Promise<Awaited<ReturnType<typeof savePlacedBeatPreviewOnly>>>;
}

const defaultServices: PlacedBeatPreviewBackfillServices = {
  savePlacedBeatPreviewOnly,
};

export async function backfillPlacedBeatPreview(
  binding: Extract<LoadedEditorBinding, { kind: "tree" }>,
  projectId: string,
  placedBeatPreview: string,
  services: PlacedBeatPreviewBackfillServices = defaultServices,
): Promise<Extract<LoadedEditorBinding, { kind: "tree" }>> {
  if (!projectId) {
    throw new Error(`Scene project identity is unavailable: ${binding.id}`);
  }
  const persisted = await services.savePlacedBeatPreviewOnly(binding.id, {
    placedBeatPreview,
    projectId,
    baseVersion: binding.loadedVersion,
  });
  return { ...binding, loadedVersion: persisted.contentVersion };
}
