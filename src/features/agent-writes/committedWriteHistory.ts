import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  useGlobalHistoryStore,
  type HistoryCommand,
} from "@/store/globalHistoryStore";
import { applyUndoJournal } from "./undoJournal";

/** The journal stays replayable after the turn ends, within its original workspace and project. */
export function pushCommittedWriteHistory(
  projectId: string,
  command: Pick<HistoryCommand, "kind" | "label"> & {
    operationId: string;
    entityId: string;
  },
  refresh: (isCurrent: () => boolean) => Promise<void>,
) {
  const history = useGlobalHistoryStore.getState();
  if (history.isReplaying) return;
  const authority = captureMutationAuthority(projectId, getCurrentProjectId);
  const isCurrent = () => isCurrentMutationAuthority(authority);
  const replay = async (direction: "undo" | "redo") => {
    if (!isCurrent()) return;
    await applyUndoJournal(command.operationId, direction);
    if (isCurrent()) await refresh(isCurrent);
  };
  history.push({
    ...command,
    undo: () => replay("undo"),
    redo: () => replay("redo"),
  });
}
