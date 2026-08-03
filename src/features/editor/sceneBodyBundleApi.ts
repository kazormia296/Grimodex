import { invoke } from "@/lib/tauri";
import type { SceneBodyDerivedSnapshot } from "./sceneBodySnapshot";

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
  dbTransactionCount: number;
}

export async function saveSceneBodyBundle(
  payload: SaveSceneBodyBundlePayload,
): Promise<SaveSceneBodyBundleResult> {
  return invoke<SaveSceneBodyBundleResult>("save_scene_body_bundle", {
    payload,
  });
}
