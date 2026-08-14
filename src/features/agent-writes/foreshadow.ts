/**
 * Agent foreshadow writes — chat-agent counterpart of the MCP foreshadow
 * tools, on the same tracked path (tracked_foreshadow_create/update:
 * entity + undo_journal + change_event in one tx, surface "in-app-agent").
 * Mirrors the codex/snippet agent-write shape: knowledgeWrite gate →
 * tracked invoke → store reload → globalHistory undo push.
 */
import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import { applyUndoJournal } from "./undoJournal";
import type { ForeshadowRow } from "@/features/foreshadow/types";

export type AgentForeshadowLoadBearing = "critical" | "supporting" | "optional";

export interface AgentForeshadowCreateInput {
  /** Stable identity of the logical request; distinct from the created entity. */
  requestId: string;
  /** Reuse this domain ID when retrying the same logical create. */
  foreshadowId?: string;
  title: string;
  intent?: string;
  notes?: string;
  loadBearing?: AgentForeshadowLoadBearing;
  /** Defaults to true (MCP parity): secret plants stay out of AI context. */
  secret?: boolean;
}

export interface AgentForeshadowUpdateInput {
  /** Stable identity of the logical update; retries must reuse this value. */
  requestId: string;
  foreshadowId: string;
  /** Version returned by the read that informed this update. */
  baseVersion: number;
  title?: string;
  intent?: string;
  notes?: string;
  loadBearing?: AgentForeshadowLoadBearing;
  payoffConfirmed?: boolean;
  abandoned?: boolean;
  secret?: boolean;
}

interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}

const LOAD_BEARING_VALUES: ReadonlySet<string> = new Set([
  "critical",
  "supporting",
  "optional",
]);

function assertLoadBearing(value: string | undefined): void {
  if (value !== undefined && !LOAD_BEARING_VALUES.has(value)) {
    throw new Error(
      `loadBearing must be one of critical|supporting|optional, got '${value}'`,
    );
  }
}

async function reloadAndFind(
  projectId: string,
  entityId: string,
): Promise<ForeshadowRow> {
  await useForeshadowStore.getState().load(projectId);
  const item = useForeshadowStore
    .getState()
    .items.find((i) => i.id === entityId);
  if (!item) {
    throw new Error(`Foreshadow ${entityId} not found after reload`);
  }
  return item;
}

function pushUndo(label: string, projectId: string, result: AgentWriteResult) {
  if (useGlobalHistoryStore.getState().isReplaying) return;
  const journalId = result.undoJournalId;
  useGlobalHistoryStore.getState().push({
    kind: "foreshadow",
    label,
    operationId: journalId,
    entityId: result.entityId,
    async undo() {
      await applyUndoJournal(journalId, "undo");
      await useForeshadowStore.getState().load(projectId);
    },
    async redo() {
      await applyUndoJournal(journalId, "redo");
      await useForeshadowStore.getState().load(projectId);
    },
  });
}

export async function agentCreateForeshadow(
  input: AgentForeshadowCreateInput,
): Promise<ForeshadowRow> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }
  assertLoadBearing(input.loadBearing);
  if (input.requestId.trim().length === 0) {
    throw new Error("requestId must be a non-empty string");
  }

  const projectId = getCurrentProjectId();
  const foreshadowId = input.foreshadowId ?? crypto.randomUUID();
  const writeContext = createCanonicalWriteContext(
    "ai-apply",
    undefined,
    input.requestId,
  );
  const result = await invoke<AgentWriteResult>("agent_foreshadow_create", {
    payload: {
      ...writeContext,
      requestId: input.requestId,
      foreshadowId,
      projectId,
      sessionId: getRecorderSessionId(),
      title: input.title,
      intent: input.intent ?? null,
      notes: input.notes ?? null,
      loadBearing: input.loadBearing ?? null,
      secret: input.secret ?? true,
    },
  });

  const item = await reloadAndFind(projectId, result.entityId);
  pushUndo(i18next.t("foreshadow.store.agentHistoryCreate"), projectId, result);
  return item;
}

export async function agentUpdateForeshadow(
  input: AgentForeshadowUpdateInput,
): Promise<ForeshadowRow> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }
  assertLoadBearing(input.loadBearing);
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
    throw new Error("baseVersion must be a non-negative integer");
  }
  if (input.requestId.trim().length === 0) {
    throw new Error("requestId must be a non-empty string");
  }
  const hasPatch =
    input.title !== undefined ||
    input.intent !== undefined ||
    input.notes !== undefined ||
    input.loadBearing !== undefined ||
    input.payoffConfirmed !== undefined ||
    input.abandoned !== undefined ||
    input.secret !== undefined;
  if (!hasPatch) {
    throw new Error("no fields provided to update");
  }

  const projectId = getCurrentProjectId();
  const writeContext = createCanonicalWriteContext(
    "ai-apply",
    undefined,
    input.requestId,
  );
  const result = await invoke<AgentWriteResult>("agent_foreshadow_update", {
    payload: {
      ...writeContext,
      requestId: input.requestId,
      projectId,
      sessionId: getRecorderSessionId(),
      foreshadowId: input.foreshadowId,
      baseVersion: input.baseVersion,
      title: input.title ?? null,
      intent: input.intent ?? null,
      notes: input.notes ?? null,
      loadBearing: input.loadBearing ?? null,
      payoffConfirmed: input.payoffConfirmed ?? null,
      abandoned: input.abandoned ?? null,
      secret: input.secret ?? null,
    },
  });

  const item = await reloadAndFind(projectId, result.entityId);
  pushUndo(i18next.t("foreshadow.store.agentHistoryUpdate"), projectId, result);
  return item;
}
