import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
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
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";

export interface AgentCodexCreateInput {
  /** Stable identity of the logical request; distinct from the created entity. */
  requestId: string;
  /** Reuse this domain ID when retrying the same logical create. */
  entryId?: string;
  type: string;
  name: string;
  summary?: string;
  content?: string;
  aliases?: string;
  parentId?: string;
  sourceChatMessageId?: string;
  model?: string | null;
  traceId?: string | null;
  excludedAliases?: string | null;
  readings?: string | null;
  tagsCache?: string | null;
}

export interface TrackedWriteOpts {
  /** undo_journal/change-event に記録する書き込み面。 */
  surface?: string;
  /** AI policy gate を UI の手動編集経路では省略する。 */
  skipPolicyGate?: boolean;
  /** 明示 project スコープ。 */
  projectId?: string;
  /** Main-issued capability for the exact interactive agent tool call. */
  agentAuthorityCapability?: string;
  /** Persisted assistant message and model tool-call identities. */
  chatMessageId?: string;
  toolCallId?: string;
  executionId?: string;
  mainOwnedProvenanceId?: string;
}

export interface AgentCodexUpdateInput {
  /** Stable identity of the logical update request when the caller can retry. */
  requestId?: string;
  entryId: string;
  type?: string;
  name?: string | null;
  summary?: string | null;
  content?: string | null;
  aliases?: string | null;
  excludedAliases?: string | null;
  readings?: string | null;
  tagsCache?: string | null;
  parentId?: string | null;
  contextMode?: string | null;
  icon?: string | null;
  childrenBudget?: string | null;
  notes?: string | null;
  model?: string | null;
  traceId?: string | null;
}

interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
  maintenanceTransactionId: string;
}

function agentCodexWriteContext(
  surface: string | undefined,
  requestId?: string,
  provenance?: {
    traceId?: string | null;
    chatMessageId?: string | null;
    toolCallId?: string | null;
  },
  authority?: Pick<
    TrackedWriteOpts,
    | "agentAuthorityCapability"
    | "chatMessageId"
    | "toolCallId"
    | "executionId"
    | "mainOwnedProvenanceId"
  >,
) {
  const stableRequestId = requestId ?? crypto.randomUUID();
  return createCanonicalWriteContext(
    surface === "manual" ? "human" : "ai-apply",
    undefined,
    stableRequestId,
    surface === "manual"
      ? undefined
      : {
          provenance: {
            requestId: stableRequestId,
            traceId: provenance?.traceId ?? stableRequestId,
            ...(provenance?.chatMessageId
              ? { chatMessageId: provenance.chatMessageId }
              : {}),
            ...(provenance?.toolCallId
              ? { toolCallId: provenance.toolCallId }
              : {}),
          },
          ...(authority?.agentAuthorityCapability
            ? { agentAuthorityCapability: authority.agentAuthorityCapability }
            : {}),
          ...(authority?.chatMessageId
            ? { chatMessageId: authority.chatMessageId }
            : {}),
          ...(authority?.toolCallId
            ? { toolCallId: authority.toolCallId }
            : {}),
          ...(authority?.executionId
            ? { executionId: authority.executionId }
            : {}),
          ...(authority?.mainOwnedProvenanceId
            ? { mainOwnedProvenanceId: authority.mainOwnedProvenanceId }
            : {}),
        },
  );
}

function buildCodexAuthorshipSpans(
  input: { summary?: string | null; content?: string | null },
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
  writeOpts?: TrackedWriteOpts,
): Promise<CodexEntry> {
  if (!writeOpts?.skipPolicyGate && blockIfPolicyOff("knowledgeWrite")) {
    throw new Error("knowledgeWrite policy is off");
  }
  if (input.requestId.trim().length === 0) {
    throw new Error("requestId must be a non-empty string");
  }

  const projectId = writeOpts?.projectId ?? getCurrentProjectId();
  const entryId = input.entryId ?? `codex-entry:${input.requestId}`;
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
  const writeContext = agentCodexWriteContext(
    writeOpts?.surface,
    input.requestId,
    {
      traceId: input.traceId ?? chatMessageId,
      chatMessageId,
      toolCallId: writeOpts?.toolCallId,
    },
    writeOpts,
  );

  const result = await invoke<AgentWriteResult>("agent_codex_create", {
    payload: {
      ...writeContext,
      canonicalPayload: {
        type: input.type,
        name: input.name,
        parentId: input.parentId ?? null,
      },
      entryId,
      projectId,
      surface: writeOpts?.surface ?? null,
      typeSlug: input.type,
      name: input.name,
      summary: input.summary ?? null,
      content: content ?? null,
      aliases: input.aliases ?? null,
      excludedAliases: input.excludedAliases ?? null,
      readings: input.readings ?? null,
      tagsCache: input.tagsCache ?? null,
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
      operationId: journalId,
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
  options?: { restoreHuman?: boolean; writeOpts?: TrackedWriteOpts },
): Promise<CodexEntry> {
  if (
    !options?.writeOpts?.skipPolicyGate &&
    blockIfPolicyOff("knowledgeWrite")
  ) {
    throw new Error("knowledgeWrite policy is off");
  }

  const projectId = options?.writeOpts?.projectId ?? getCurrentProjectId();
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
  const writeContext = agentCodexWriteContext(
    options?.restoreHuman ? "manual" : options?.writeOpts?.surface,
    input.requestId,
    {
      traceId: input.traceId ?? chatMessageId,
      chatMessageId,
      toolCallId: options?.writeOpts?.toolCallId,
    },
    options?.writeOpts,
  );

  const result = await invoke<AgentWriteResult>("agent_codex_update", {
    payload: {
      ...writeContext,
      canonicalPayload: {
        fields: Object.keys(input)
          .filter((field) => field !== "entryId" && field !== "requestId")
          .sort(),
      },
      projectId,
      surface: options?.writeOpts?.surface ?? null,
      entryId: input.entryId,
      baseVersion: await getCodexEntryVersion(projectId, input.entryId),
      ...(input.type !== undefined ? { typeSlug: input.type } : {}),
      ...(input.name !== undefined
        ? { name: input.name === null ? "" : input.name }
        : {}),
      ...(input.summary !== undefined
        ? { summary: input.summary === null ? "" : input.summary }
        : {}),
      ...(input.content !== undefined
        ? { content: content === null ? "" : content }
        : {}),
      ...(input.aliases !== undefined
        ? { aliases: input.aliases === null ? "" : input.aliases }
        : {}),
      ...(input.excludedAliases !== undefined
        ? {
            excludedAliases:
              input.excludedAliases === null ? "" : input.excludedAliases,
          }
        : {}),
      ...(input.readings !== undefined
        ? { readings: input.readings === null ? "" : input.readings }
        : {}),
      ...(input.tagsCache !== undefined
        ? { tagsCache: input.tagsCache === null ? "" : input.tagsCache }
        : {}),
      ...(input.parentId !== undefined
        ? { parentId: input.parentId === null ? "" : input.parentId }
        : {}),
      ...(input.contextMode !== undefined
        ? { contextMode: input.contextMode === null ? "" : input.contextMode }
        : {}),
      ...(input.icon !== undefined
        ? { icon: input.icon === null ? "" : input.icon }
        : {}),
      ...(input.childrenBudget !== undefined
        ? {
            childrenBudget:
              input.childrenBudget === null ? "" : input.childrenBudget,
          }
        : {}),
      ...(input.notes !== undefined
        ? { notes: input.notes === null ? "" : input.notes }
        : {}),
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
      operationId: journalId,
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
