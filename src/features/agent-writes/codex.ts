import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { aiAuthorshipAttrs } from "@/features/attribution/aiAuthorship";
import {
  extractAiSpansFromPmJson,
  syntheticAiSpans,
  type AgentAuthorshipSpanInput,
} from "./authorshipSpans";
import { applyUndoJournal } from "./undoJournal";
import type { CodexEntry } from "@/features/codex/api";
import { getCodexEntryVersion } from "@/features/codex/version";
import { scheduleCodexIndex } from "@/features/semantic-search/scheduler";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import { notifySameRendererDocumentWrite } from "@/features/concurrency/documentWriteNotification";
import { validateAgentProseMirrorJson } from "./richTextInput";

export interface AgentCodexCreateInput {
  type: string;
  name: string;
  summary?: string;
  content?: string;
  aliases?: string;
  parentId?: string;
  sourceChatMessageId?: string;
  model?: string | null;
  traceId?: string | null;
}

export interface AgentCodexUpdateInput {
  entryId: string;
  name?: string;
  summary?: string;
  content?: string;
  aliases?: string;
  model?: string | null;
  traceId?: string | null;
}

interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}

function buildCodexAuthorshipSpans(
  input: { summary?: string; content?: string },
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  },
): AgentAuthorshipSpanInput[] {
  const spans: AgentAuthorshipSpanInput[] = [];
  if (input.summary) {
    spans.push(...syntheticAiSpans(input.summary, opts));
  }
  if (input.content) {
    spans.push(...extractAiSpansFromPmJson(input.content, opts));
  }
  return spans;
}

function spanLanes(spans: AgentAuthorshipSpanInput[]): Array<string | null> {
  return spans.map((s) => s.lane ?? null);
}

/** Apply AI authorship marks to a PM JSON content string before persistence. */
export function markCodexContentAsAi(
  contentJson: string,
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  } = {},
): string {
  const normalized = validateAgentProseMirrorJson(contentJson);
  const doc = JSON.parse(normalized) as Record<string, unknown>;
  const attrs = aiAuthorshipAttrs({
    model: opts.model,
    chatMessageId: opts.chatMessageId,
    traceId: opts.traceId,
  });
  applyAiMarkToDoc(doc, attrs);
  return validateAgentProseMirrorJson(JSON.stringify(doc));
}

function applyAiMarkToDoc(
  node: Record<string, unknown>,
  attrs: Record<string, unknown>,
): void {
  if (node.type === "text" && typeof node.text === "string") {
    const marks = (node.marks as Record<string, unknown>[] | undefined) ?? [];
    if (!marks.some((m) => m.type === "authorship")) {
      node.marks = [...marks, { type: "authorship", attrs }];
    }
    return;
  }
  const content = node.content as Record<string, unknown>[] | undefined;
  if (content) {
    for (const child of content) applyAiMarkToDoc(child, attrs);
  }
}

export async function agentCreateCodexEntry(
  input: AgentCodexCreateInput,
  chatMessageId?: string | null,
): Promise<CodexEntry> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }

  const projectId = getCurrentProjectId();
  const content = input.content
    ? markCodexContentAsAi(input.content, {
        model: input.model,
        chatMessageId,
        traceId: input.traceId,
      })
    : undefined;

  const authorshipSpans = buildCodexAuthorshipSpans(
    { summary: input.summary, content },
    {
      model: input.model,
      chatMessageId,
      traceId: input.traceId,
    },
  );

  const result = await invoke<AgentWriteResult>("agent_codex_create", {
    payload: {
      projectId,
      sessionId: getRecorderSessionId(),
      typeSlug: input.type,
      name: input.name,
      summary: input.summary ?? null,
      content: content ?? null,
      aliases: input.aliases ?? null,
      parentId: input.parentId ?? null,
      sourceChatMessageId: input.sourceChatMessageId ?? chatMessageId ?? null,
      model: input.model ?? null,
      chatMessageId: chatMessageId ?? null,
      traceId: input.traceId ?? null,
      authorshipSpans,
    },
  });

  await useCodexStore.getState().loadEntries();

  // 段階3: agent 経路の codex 作成も semantic index へ (api.ts は通らないため
  // ここで明示フック)。debounce + Rust 側 hash 再検証で冪等。
  scheduleCodexIndex(result.entityId);
  scheduleImeExportRefresh(projectId);

  const entry = useCodexStore
    .getState()
    .entries.find((e) => e.id === result.entityId);
  if (!entry) {
    throw new Error(
      `Created codex entry ${result.entityId} not found after reload`,
    );
  }

  if (!useGlobalHistoryStore.getState().isReplaying) {
    const journalId = result.undoJournalId;
    const entityId = result.entityId;
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: i18next.t("codex.store.agentHistoryCreate"),
      entityId,
      async undo() {
        await applyUndoJournal(journalId, "undo");
        await useCodexStore.getState().loadEntries();
        scheduleImeExportRefresh(projectId);
      },
      async redo() {
        await applyUndoJournal(journalId, "redo");
        await useCodexStore.getState().loadEntries();
        scheduleImeExportRefresh(projectId);
      },
    });
  }

  return entry;
}

export async function agentUpdateCodexEntry(
  input: AgentCodexUpdateInput,
  chatMessageId?: string | null,
  options?: { restoreHuman?: boolean },
): Promise<CodexEntry> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }

  const projectId = getCurrentProjectId();
  const before = useCodexStore
    .getState()
    .entries.find((e) => e.id === input.entryId);
  if (!before) {
    throw new Error(`Codex entry ${input.entryId} not found`);
  }

  const restoreHuman = options?.restoreHuman === true;
  const content =
    !restoreHuman && input.content
      ? markCodexContentAsAi(input.content, {
          model: input.model,
          chatMessageId,
          traceId: input.traceId,
        })
      : input.content;

  const authorshipSpans =
    !restoreHuman && (input.summary !== undefined || content !== undefined)
      ? buildCodexAuthorshipSpans(
          { summary: input.summary, content },
          {
            model: input.model,
            chatMessageId,
            traceId: input.traceId,
          },
        )
      : undefined;

  const result = await invoke<AgentWriteResult>("agent_codex_update", {
    payload: {
      projectId,
      sessionId: getRecorderSessionId(),
      entryId: input.entryId,
      baseVersion: await getCodexEntryVersion(projectId, input.entryId),
      name: input.name ?? null,
      summary: input.summary ?? null,
      content: content ?? null,
      aliases: input.aliases ?? null,
      model: restoreHuman ? null : (input.model ?? null),
      chatMessageId: chatMessageId ?? null,
      traceId: input.traceId ?? null,
      authorshipSpans: authorshipSpans ?? null,
      authorshipSpanLanes: authorshipSpans ? spanLanes(authorshipSpans) : null,
    },
  });

  await useCodexStore.getState().loadEntries();
  notifySameRendererDocumentWrite(
    { kind: "codex", id: result.entityId, phaseId: null },
    {
      domain: "codex",
      opType: "entry.update",
      entityId: result.entityId,
    },
  );

  // 段階3: agent 経路の codex 更新も semantic index へ (api.ts は通らない)。
  scheduleCodexIndex(result.entityId);
  if (input.name !== undefined || input.aliases !== undefined) {
    scheduleImeExportRefresh(projectId);
  }

  const entry = useCodexStore
    .getState()
    .entries.find((e) => e.id === result.entityId);
  if (!entry) {
    throw new Error(
      `Updated codex entry ${result.entityId} not found after reload`,
    );
  }

  if (!useGlobalHistoryStore.getState().isReplaying) {
    const journalId = result.undoJournalId;
    const entityId = input.entryId;
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: i18next.t("codex.store.agentHistoryUpdate"),
      entityId,
      async undo() {
        await applyUndoJournal(journalId, "undo");
        await useCodexStore.getState().loadEntries();
        scheduleImeExportRefresh(projectId);
      },
      async redo() {
        await applyUndoJournal(journalId, "redo");
        await useCodexStore.getState().loadEntries();
        scheduleImeExportRefresh(projectId);
      },
    });
  }

  return entry;
}
