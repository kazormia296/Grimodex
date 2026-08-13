import { invoke } from "@/lib/tauri";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

const pendingReplayRequestIds = new Map<string, string>();

function replayRequestKey(
  projectId: string,
  journalId: string,
  direction: "undo" | "redo",
): string {
  return `${projectId}\0${journalId}\0${direction}`;
}

export async function applyUndoJournal(
  journalId: string,
  direction: "undo" | "redo",
  explicitRequestId?: string,
): Promise<void> {
  const projectId = getCurrentProjectId();
  const key = replayRequestKey(projectId, journalId, direction);
  const requestId =
    explicitRequestId ??
    pendingReplayRequestIds.get(key) ??
    crypto.randomUUID();
  // Register before crossing IPC. Any rejection can represent an unresolved
  // replay, so only a confirmed success releases this logical-cycle identity.
  pendingReplayRequestIds.set(key, requestId);
  await invoke("agent_apply_undo_journal", {
    payload: {
      requestId,
      projectId,
      sessionId: getRecorderSessionId(),
      journalId,
      direction,
    },
  });
  if (pendingReplayRequestIds.get(key) === requestId) {
    pendingReplayRequestIds.delete(key);
  }
}
