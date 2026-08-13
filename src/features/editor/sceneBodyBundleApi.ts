import { invoke } from "@/lib/tauri";
import type { SceneBodyDerivedSnapshot } from "./sceneBodySnapshot";
import { normalizeForeshadowRow } from "@/features/foreshadow/normalizeForeshadowRow";
import type { ForeshadowRow } from "@/features/foreshadow/types";

export interface SaveSceneBodyBundlePayload extends SceneBodyDerivedSnapshot {
  sceneId: string;
  projectId: string;
  requestId: string;
  sessionId: string;
  eventUid: string;
  origin: "human" | "ai-apply";
  /**
   * Replayable ProseMirror steps for a headless body mutation. When present,
   * the Native writer adopts them as its canonical `doc.step` Change Event so
   * the replay row cannot commit separately from the body and Change Feed.
   */
  timelapseSteps?: readonly unknown[];
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
