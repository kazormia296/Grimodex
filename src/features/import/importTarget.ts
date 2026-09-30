import type { ImportSource, MarkdownImportMode } from "./importTypes";
import { useProjectStore } from "@/features/project/projectStore";

/** Where imported content should land. */
export type ImportTarget = "newProject" | "currentProject";

export function defaultImportTarget(
  source: ImportSource,
  markdownMode?: MarkdownImportMode,
): ImportTarget {
  if (source === "markdown" && markdownMode === "single") {
    return "currentProject";
  }
  return "newProject";
}

/** Opt-in flag for the new import session wizard pipeline. */
export function isNewImportSessionPipelinePreferred(): boolean {
  return import.meta.env.VITE_GRIMODEX_IMPORT_SESSION_PIPELINE === "new";
}

/** Opt-in flag for generic semantic import adapter preview. */
export function isGenericImportAdapterPreferred(): boolean {
  return import.meta.env.VITE_GRIMODEX_GENERIC_IMPORT_ADAPTER === "new";
}

export interface PrepareImportTargetMeta {
  title: string;
  genre?: string;
  language?: string;
}

/** Create and switch to a new project when importing into a fresh container. */
export async function prepareImportTarget(
  target: ImportTarget,
  meta: PrepareImportTargetMeta,
): Promise<void> {
  if (target === "currentProject") return;

  const title = meta.title.trim();
  await useProjectStore.getState().createNewProject({
    title: title || "Imported",
    genre: meta.genre || undefined,
    language: meta.language || undefined,
  });
}
