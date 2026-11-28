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
import { AiPolicyWriteBlockedError } from "@/features/ai-policy/writeBlockedError";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import {
  reloadForeshadowsAfterCommit,
  useForeshadowStore,
} from "@/features/foreshadow/foreshadowStore";
import {
  createCanonicalWriteContext,
  type CanonicalWriteAuthorityOptions,
} from "@/features/native-writes/writeContext";
import { pushCommittedWriteHistory } from "./committedWriteHistory";
import type { ForeshadowRow } from "@/features/foreshadow/types";

export type AgentForeshadowLoadBearing = "critical" | "supporting" | "optional";

export type AgentAuthorityWriteOptions = Pick<
  CanonicalWriteAuthorityOptions,
  | "agentAuthorityCapability"
  | "chatMessageId"
  | "toolCallId"
  | "executionId"
  | "mainOwnedProvenanceId"
>;

export interface AgentForeshadowCreateInput {
  /** Stable identity of the logical request; distinct from the created entity. */
  requestId: string;
  /** Reuse this domain ID when retrying the same logical create. */
  foreshadowId?: string;
  title: string;
  intent?: string;
  notes?: string;
  loadBearing?: AgentForeshadowLoadBearing;
  /** Defaults to false: new plants are visible to the AI. */
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

type ForeshadowWriteTool = "create_foreshadow" | "update_foreshadow";

function registerForeshadowHistory(
  tool: ForeshadowWriteTool,
  projectId: string,
  entityId: string,
  journalId: string,
): ForeshadowRow {
  const item = useForeshadowStore
    .getState()
    .items.find((i) => i.id === entityId && i.projectId === projectId);
  if (!item) {
    throw new Error(`Foreshadow ${entityId} not found after reload`);
  }
  pushCommittedWriteHistory(
    projectId,
    {
      kind: "foreshadow",
      label: i18next.t(
        tool === "create_foreshadow"
          ? "foreshadow.store.agentHistoryCreate"
          : "foreshadow.store.agentHistoryUpdate",
      ),
      operationId: journalId,
      entityId,
    },
    (isCurrent) => reloadForeshadowsAfterCommit(projectId, isCurrent, false),
  );
  return item;
}

export async function projectMastraForeshadowWrite(
  tool: ForeshadowWriteTool,
  projectId: string,
  entityId: string,
  journalId: string,
  isCurrent: () => boolean,
): Promise<void> {
  if (!isCurrent()) return;
  await reloadForeshadowsAfterCommit(projectId, isCurrent);
  if (!isCurrent()) return;
  registerForeshadowHistory(tool, projectId, entityId, journalId);
}

export async function agentCreateForeshadow(
  input: AgentForeshadowCreateInput,
  authority?: AgentAuthorityWriteOptions,
): Promise<ForeshadowRow> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new AiPolicyWriteBlockedError("knowledgeWrite");
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
    {
      authorityRoute: "interactive-agent-command",
      ...authority,
      provenance: {
        requestId: input.requestId,
        traceId: authority?.chatMessageId ?? input.requestId,
        ...(authority?.chatMessageId
          ? { chatMessageId: authority.chatMessageId }
          : {}),
        ...(authority?.toolCallId ? { toolCallId: authority.toolCallId } : {}),
      },
    },
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
      secret: input.secret ?? false,
    },
  });

  await useForeshadowStore.getState().load(projectId);
  return registerForeshadowHistory(
    "create_foreshadow",
    projectId,
    result.entityId,
    result.undoJournalId,
  );
}

export async function agentUpdateForeshadow(
  input: AgentForeshadowUpdateInput,
  authority?: AgentAuthorityWriteOptions,
): Promise<ForeshadowRow> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new AiPolicyWriteBlockedError("knowledgeWrite");
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
    {
      authorityRoute: "interactive-agent-command",
      ...authority,
      provenance: {
        requestId: input.requestId,
        traceId: authority?.chatMessageId ?? input.requestId,
        ...(authority?.chatMessageId
          ? { chatMessageId: authority.chatMessageId }
          : {}),
        ...(authority?.toolCallId ? { toolCallId: authority.toolCallId } : {}),
      },
    },
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

  await useForeshadowStore.getState().load(projectId);
  return registerForeshadowHistory(
    "update_foreshadow",
    projectId,
    result.entityId,
    result.undoJournalId,
  );
}
