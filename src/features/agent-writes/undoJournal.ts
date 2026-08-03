import { invoke } from "@/lib/tauri";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

export async function applyUndoJournal(
  journalId: string,
  direction: "undo" | "redo",
  requestId: string = crypto.randomUUID(),
): Promise<void> {
  await invoke("agent_apply_undo_journal", {
    payload: {
      requestId,
      projectId: getCurrentProjectId(),
      sessionId: getRecorderSessionId(),
      journalId,
      direction,
    },
  });
}
