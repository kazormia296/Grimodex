import { isFileBackedSourceUri } from "@/features/external-mount/sourceUri";
import { serializeProseMirrorDocument } from "@/features/narrative-extraction/source/proseMirrorSerializer";
import type { ProjectNarrativeSourceRow } from "@/features/narrative-extraction/source/types";
import { loadProjectNarrativeSourceRows } from "@/features/tree/api";

/**
 * The extraction window planner's owned-text budget (UTF-16 code units).
 * Re-exported so callers compare a Scene's length against the one constant.
 */
export { DEFAULT_MAX_WINDOW_OWNED_CHARS } from "@/features/chronicle/extraction/windowPlanner";

export type SceneBodyLengthErrorCode =
  | "SCENE_BODY_ROW_UNAVAILABLE"
  | "SCENE_BODY_UNREADABLE";

export class SceneBodyLengthError extends Error {
  readonly code: SceneBodyLengthErrorCode;

  constructor(code: SceneBodyLengthErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SceneBodyLengthError";
    this.code = code;
  }
}

export interface SceneBodyLengthDeps {
  readonly loadSourceRows?: (
    projectId: string,
    orderedSceneIds: readonly string[],
  ) => Promise<ProjectNarrativeSourceRow[]>;
}

/**
 * Length of one Scene's canonical (normalized) body, counted exactly as the
 * extraction snapshot seals it: the same persisted-row read and the same
 * serializer/schema choice (`file-backed` for external-mount sources).
 *
 * Call after the Scene has been saved; this reads persisted rows only.
 * Throws `SceneBodyLengthError` when the row cannot be read or serialized.
 */
export async function measureSceneCanonicalBodyLength(
  projectId: string,
  sceneId: string,
  deps: SceneBodyLengthDeps = {},
): Promise<{ canonicalLength: number }> {
  const load = deps.loadSourceRows ?? loadProjectNarrativeSourceRows;
  const row = (await load(projectId, [sceneId])).find(
    (candidate) => candidate.nodeId === sceneId,
  );
  if (!row) {
    throw new SceneBodyLengthError(
      "SCENE_BODY_ROW_UNAVAILABLE",
      `Scene ${sceneId} is not available in the persisted Project`,
    );
  }
  const serialized = serializeProseMirrorDocument(
    row.content,
    isFileBackedSourceUri(row.sourceUri) ? "file-backed" : "database",
  );
  if (!serialized.ok) {
    throw new SceneBodyLengthError(
      "SCENE_BODY_UNREADABLE",
      `Scene ${sceneId} body could not be normalized (${serialized.diagnostics
        .map((item) => item.code)
        .join(", ")})`,
    );
  }
  return { canonicalLength: serialized.canonical.text.length };
}
