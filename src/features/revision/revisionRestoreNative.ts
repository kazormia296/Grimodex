import { invoke } from "@/lib/tauri";

export interface RestoreSceneRevisionPayload {
  requestId: string;
  sessionId: string;
  projectId: string;
  entityType: "scene";
  entityId: string;
  revisionId: string;
  /** Exact persisted target revision content; Native verifies it by revisionId. */
  content: string;
  /** Exact persisted scene head; Native verifies it against DB. */
  currentContent: string;
  expectedVersion: number;
  charCount: number;
  placedBeatPreview: string | null;
}

export interface RestoreSceneRevisionResult {
  sceneId: string;
  revisionId: string;
  safetyRevisionId: string;
  version: number;
  updatedAt: string;
  changeEventUid: string;
  canonicalSequence: number;
  maintenanceTransactionId: string;
  replayed: boolean;
}

export async function restoreSceneRevisionNative(
  payload: RestoreSceneRevisionPayload,
): Promise<RestoreSceneRevisionResult> {
  return invoke<RestoreSceneRevisionResult>("revision_scene_restore", {
    payload,
  });
}
