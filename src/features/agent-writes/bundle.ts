import { invoke } from "@/lib/tauri";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

export interface BatchStatement {
  sql: string;
  params: unknown[];
  method: string;
}

export interface UndoJournalPayload {
  entityKind: string;
  entityId: string;
  opKind: string;
  beforeJson: string | null;
  afterJson: string | null;
  baseVersion: number;
  resultVersion: number;
}

export interface ChangeEventPayload {
  eventUid: string;
  sceneId: string | null;
  domain: string;
  opType: string;
  entityType: string | null;
  entityId: string | null;
  payload: string;
  timestamp: number;
}

export interface AgentWriteBundleInput {
  projectId: string;
  surface?: string;
  statements: BatchStatement[];
  undoJournal: UndoJournalPayload;
  changeEvent: ChangeEventPayload;
}

export interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}

/** Execute SQL statements + undo-journal + change_event in one BEGIN IMMEDIATE tx. */
export async function agentWriteBundle(
  input: AgentWriteBundleInput,
): Promise<AgentWriteResult> {
  return invoke<AgentWriteResult>("agent_write_bundle", {
    payload: {
      projectId: input.projectId,
      sessionId: getRecorderSessionId(),
      surface: input.surface ?? "in-app-agent",
      statements: input.statements,
      undoJournal: input.undoJournal,
      changeEvent: input.changeEvent,
    },
  });
}
