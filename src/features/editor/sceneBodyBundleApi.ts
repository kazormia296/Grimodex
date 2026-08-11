import { invoke } from "@/lib/tauri";
import type { SceneBodyDerivedSnapshot } from "./sceneBodySnapshot";
import { normalizeForeshadowRow } from "@/features/foreshadow/normalizeForeshadowRow";
import type { ForeshadowRow } from "@/features/foreshadow/types";

export interface SaveSceneBodyBundlePayload extends SceneBodyDerivedSnapshot {
  sceneId: string;
  projectId: string;
  includeSidecars: boolean;
  /** Loaded scene version for editor OCC; omitted by headless writers. */
  baseVersion?: number;
  /** Renderer-wide monotonic tree token for the authoritative content row. */
  updatedAt: string;
}

export interface SaveSceneBodyBundleResult {
  placedBeatPreview: string | null;
  unplacedBeatPreview: string | null;
  contentVersion: number;
  contentUpdatedAt: string;
  foreshadowRows: ForeshadowRow[];
  dbTransactionCount: number;
}

export async function saveSceneBodyBundle(
  payload: SaveSceneBodyBundlePayload,
): Promise<SaveSceneBodyBundleResult> {
  const result = await invoke<
    Omit<SaveSceneBodyBundleResult, "foreshadowRows"> & {
      foreshadowRows: unknown[];
    }
  >("save_scene_body_bundle", {
    payload,
  });
  return {
    ...result,
    foreshadowRows: result.foreshadowRows.map(normalizeForeshadowRow),
  };
}
