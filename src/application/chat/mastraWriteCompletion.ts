import { and, eq, sql } from "drizzle-orm";
import {
  parseMastraAgentWriteCompletedEvent,
  type MastraAgentWriteCompletedEvent,
  MASTRA_AGENT_WRITE_COMPLETED_EVENT,
} from "@/../electron/shared/ipcContract";
import type {
  MastraAgentTurnStartRequest,
  MastraAgentWriteToolName,
} from "@/../electron/shared/mastraAgentTurnWire";
import { useProjectStore } from "@/features/project/projectStore";
import { subscribeCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { db } from "@/db/client";
import { changeEvents, codexEntries, snippets, undoJournal } from "@/db/schema";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import { getEventVersion } from "@/features/chronicle/version";
import { projectCodexWrite } from "@/features/agent-writes/codex";
import { projectMastraForeshadowWrite } from "@/features/agent-writes/foreshadow";
import { projectSnippetWrite } from "@/features/agent-writes/snippet";
import { projectChronicleWrite } from "@/features/agent-writes/event";
import { debugLog } from "@/lib/debugLog";
import { listen } from "@/lib/tauri";

interface WriteOperation {
  tool: MastraAgentWriteToolName;
  domain: string;
  entityKind: string;
  chronicleCommand?: string;
}

function chronicle(
  tool: MastraAgentWriteToolName,
  chronicleCommand: string,
): WriteOperation {
  return { tool, chronicleCommand, domain: "event", entityKind: "event" };
}

const operations = new Map<string, WriteOperation>([
  [
    "entry.create",
    { tool: "create_codex_entry", domain: "codex", entityKind: "codex_entry" },
  ],
  [
    "entry.update",
    { tool: "update_codex_entry", domain: "codex", entityKind: "codex_entry" },
  ],
  [
    "foreshadow.create",
    {
      tool: "create_foreshadow",
      domain: "foreshadow",
      entityKind: "foreshadow",
    },
  ],
  [
    "foreshadow.update",
    {
      tool: "update_foreshadow",
      domain: "foreshadow",
      entityKind: "foreshadow",
    },
  ],
  [
    "snippet.create",
    { tool: "create_snippet", domain: "snippet", entityKind: "snippet" },
  ],
  ["event.create", chronicle("create_event", "agent_event_create")],
  ["event.update", chronicle("update_event", "agent_event_update")],
  ["event.delete", chronicle("delete_event", "agent_event_delete")],
  [
    "event.participants",
    chronicle("set_event_participants", "agent_event_set_participants"),
  ],
  ["event.stamp", chronicle("stamp_scene_event", "agent_scene_event_link")],
  [
    "event.unstamp",
    chronicle("unstamp_scene_event", "agent_scene_event_unlink"),
  ],
  [
    "event.relation_add",
    chronicle("add_event_relation", "agent_event_relation_add"),
  ],
  [
    "event.relation_remove",
    chronicle("remove_event_relation", "agent_event_relation_remove"),
  ],
]);

export async function receiveMastraWriteCompletions(
  request: MastraAgentTurnStartRequest,
  isDispatched: () => boolean,
): Promise<(() => Promise<void>) | undefined> {
  if (
    ![...operations.values()].some(({ tool }) => request.tools.includes(tool))
  )
    return;
  const authority = captureMutationAuthority(
    request.projectId,
    getCurrentProjectId,
  );
  let scopeLost =
    authority.workspaceOpenRevision === null ||
    !isCurrentMutationAuthority(authority);
  const isCurrent = () =>
    !scopeLost && isDispatched() && isCurrentMutationAuthority(authority);
  let accepting = true;
  let pending = Promise.resolve();
  const applied = new Set<string>();

  async function project(receipt: MastraAgentWriteCompletedEvent) {
    if (!isCurrent() || applied.has(receipt.undoId)) return;
    // Bind the IDs to the original Native write. The query returns operation
    // metadata only; the Canonical Change Event and Undo Journal bodies stay in SQLite.
    const [row] = await db
      .select({
        op: changeEvents.opType,
        domain: changeEvents.domain,
        entityKind: undoJournal.entityKind,
        refreshIme: sql<number>`CASE WHEN ${changeEvents.opType} = 'entry.update' THEN EXISTS (
          SELECT 1 FROM json_each(${changeEvents.payload}, '$.fields')
          WHERE type = 'text' AND value IN ('name', 'aliases')
        ) ELSE 0 END`,
      })
      .from(undoJournal)
      .innerJoin(
        changeEvents,
        and(
          eq(changeEvents.projectId, undoJournal.projectId),
          eq(changeEvents.eventUid, undoJournal.changeEventUid),
        ),
      )
      .where(
        and(
          eq(undoJournal.id, receipt.undoId),
          eq(undoJournal.projectId, request.projectId),
          eq(undoJournal.entityId, receipt.targetId),
          eq(undoJournal.entityKind, changeEvents.entityType),
          eq(undoJournal.surface, "in-app-agent"),
          // A create retry may return the original receipt for a since-deleted row.
          // The active Codex and snippet views can hide existing targets.
          sql`CASE ${undoJournal.entityKind}
            WHEN 'codex_entry' THEN EXISTS (SELECT 1 FROM ${codexEntries} WHERE ${codexEntries.id} = ${undoJournal.entityId} AND ${codexEntries.projectId} = ${undoJournal.projectId})
            WHEN 'snippet' THEN EXISTS (SELECT 1 FROM ${snippets} WHERE ${snippets.id} = ${undoJournal.entityId} AND ${snippets.projectId} = ${undoJournal.projectId})
            ELSE 1 END`,
          eq(changeEvents.entityId, receipt.targetId),
          eq(changeEvents.sessionId, request.writerSessionId),
          eq(
            sql`json_extract(${changeEvents.payload}, '$.authorityEvidence.provenance.chatMessageId')`,
            request.chatMessageId,
          ),
        ),
      )
      .limit(1);
    const operation = row && operations.get(row.op);
    if (
      !operation ||
      operation.domain !== row.domain ||
      operation.entityKind !== row.entityKind ||
      !request.tools.includes(operation.tool) ||
      !isCurrent()
    )
      return;

    const { targetId, undoId } = receipt;
    const { projectId } = request;
    const { tool } = operation;
    if (
      tool === "create_event" &&
      (await getEventVersion(projectId, targetId)) === null
    )
      return;
    if (!isCurrent()) return;
    if (tool === "create_codex_entry" || tool === "update_codex_entry") {
      await projectCodexWrite(
        tool,
        projectId,
        targetId,
        undoId,
        tool === "create_codex_entry" || row.refreshIme === 1,
        isCurrent,
      );
    } else if (tool === "create_foreshadow" || tool === "update_foreshadow") {
      await projectMastraForeshadowWrite(
        tool,
        projectId,
        targetId,
        undoId,
        isCurrent,
      );
    } else if (tool === "create_snippet") {
      await projectSnippetWrite(projectId, targetId, undoId, isCurrent);
    } else if (operation.chronicleCommand) {
      projectChronicleWrite(
        operation.chronicleCommand,
        { entityId: receipt.targetId, undoJournalId: receipt.undoId },
        row.op === "event.create"
          ? "chronicle.agentHistoryCreate"
          : row.op === "event.delete"
            ? "chronicle.agentHistoryDelete"
            : "chronicle.agentHistoryUpdate",
      );
    }
    applied.add(undoId);
  }

  // Latch scope loss even if the user immediately switches back to the same project.
  const stopProject = useProjectStore.subscribe((state) => {
    if (state.currentProjectId !== request.projectId) scopeLost = true;
  });
  const stopWorkspace = subscribeCurrentWorkspaceIdentity(() => {
    if (!isCurrentMutationAuthority(authority)) scopeLost = true;
  });
  let unlisten: () => void;
  try {
    unlisten = await listen<unknown>(
      MASTRA_AGENT_WRITE_COMPLETED_EVENT,
      (raw) => {
        if (!accepting || !isCurrent()) return;
        const receipt = parseMastraAgentWriteCompletedEvent(raw);
        if (receipt) {
          pending = pending
            .then(() => project(receipt))
            .catch(() => {
              if (isCurrent())
                debugLog.warn("ChatStore", "Mastra write projection failed");
            });
        }
      },
    );
  } catch (error) {
    stopWorkspace();
    stopProject();
    throw error;
  }

  return async () => {
    accepting = false;
    unlisten();
    try {
      // A Stop may race a committed Native write. Keep its original project
      // projection alive until receipts already accepted by this start settle.
      await pending;
    } finally {
      stopWorkspace();
      stopProject();
    }
  };
}
