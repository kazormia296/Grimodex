import { invoke } from "@/lib/tauri";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

export async function applyUndoJournal(
  journalId: string,
  direction: "undo" | "redo",
): Promise<void> {
  await invoke("agent_apply_undo_journal", {
    payload: {
      projectId: getCurrentProjectId(),
      sessionId: getRecorderSessionId(),
      journalId,
      direction,
    },
  });
}
