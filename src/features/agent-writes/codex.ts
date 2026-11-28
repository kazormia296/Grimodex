import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { AiPolicyWriteBlockedError } from "@/features/ai-policy/writeBlockedError";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { aiAuthorshipAttrs } from "@/features/attribution/aiAuthorship";
import {
  extractAiSpansFromPmJson,
  syntheticAiSpans,
  type AgentAuthorshipSpanInput,
} from "./authorshipSpans";
import { pushCommittedWriteHistory } from "./committedWriteHistory";
import type { CodexEntry } from "@/features/codex/api";
import { getCodexEntryVersion } from "@/features/codex/version";
import { scheduleCodexIndex } from "@/features/semantic-search/scheduler";
import { scheduleImeExportRefresh } from "@/features/ime/scheduler";
import { notifySameRendererDocumentWrite } from "@/features/concurrency/documentWriteNotification";
import { validateAgentProseMirrorJson } from "./richTextInput";
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";
import {
  runTimelapseBodyReplacement,
  runTimelapseMutation,
} from "@/features/timelapse/bodyWriteMode";

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
  if (surface === "manual") {
    return createCanonicalWriteContext("human", undefined, stableRequestId);
  }
  return createCanonicalWriteContext("ai-apply", undefined, stableRequestId, {
    authorityRoute: "interactive-agent-command",
    provenance: {
      requestId: stableRequestId,
      traceId: provenance?.traceId ?? stableRequestId,
      ...(provenance?.chatMessageId
        ? { chatMessageId: provenance.chatMessageId }
        : {}),
      ...(provenance?.toolCallId ? { toolCallId: provenance.toolCallId } : {}),
    },
    ...(authority?.agentAuthorityCapability
      ? { agentAuthorityCapability: authority.agentAuthorityCapability }
      : {}),
    ...(authority?.chatMessageId
      ? { chatMessageId: authority.chatMessageId }
      : {}),
    ...(authority?.toolCallId ? { toolCallId: authority.toolCallId } : {}),
    ...(authority?.executionId ? { executionId: authority.executionId } : {}),
    ...(authority?.mainOwnedProvenanceId
      ? { mainOwnedProvenanceId: authority.mainOwnedProvenanceId }
      : {}),
  });
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

/** Project a completed Native write into the renderer without issuing the write again. */
export async function projectCodexWrite(
  tool: "create_codex_entry" | "update_codex_entry",
  projectId: string,
  entityId: string,
  journalId: string,
  refreshIme: boolean,
  isCurrent?: () => boolean,
): Promise<CodexEntry | undefined> {
  if (isCurrent && !isCurrent()) return;
  const updated = tool === "update_codex_entry";
  const registerUndo = () => {
    pushCommittedWriteHistory(
      projectId,
      {
        kind: "codex",
        label: i18next.t(
          updated
            ? "codex.store.agentHistoryUpdate"
            : "codex.store.agentHistoryCreate",
        ),
        operationId: journalId,
        entityId,
      },
      async (isProjectCurrent) => {
        await useCodexStore
          .getState()
          .loadEntries({ afterWrite: isProjectCurrent });
        if (isProjectCurrent()) scheduleImeExportRefresh(projectId);
      },
    );
  };
  // The verified Native journal remains undoable even if this view cannot refresh.
  if (isCurrent) registerUndo();
  await useCodexStore
    .getState()
    .loadEntries(
      isCurrent ? { afterWrite: isCurrent, propagateError: true } : undefined,
    );
  if (isCurrent && !isCurrent()) return;

  if (updated) {
    notifySameRendererDocumentWrite(
      { kind: "codex", id: entityId, phaseId: null },
      { domain: "codex", opType: "entry.update", entityId },
    );
  }
  scheduleCodexIndex(entityId);
  if (refreshIme) scheduleImeExportRefresh(projectId);

  const entry = useCodexStore
    .getState()
    .entries.find((item) => item.id === entityId);
  if (!isCurrent && entry) registerUndo();
  return entry;
}

export async function agentCreateCodexEntry(
  input: AgentCodexCreateInput,
  chatMessageId?: string | null,
  writeOpts?: TrackedWriteOpts,
): Promise<CodexEntry> {
  if (!writeOpts?.skipPolicyGate && blockIfPolicyOff("knowledgeWrite")) {
    throw new AiPolicyWriteBlockedError("knowledgeWrite");
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

  const write = async (): Promise<CodexEntry> => {
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

    const entry = await projectCodexWrite(
      "create_codex_entry",
      projectId,
      result.entityId,
      result.undoJournalId,
      true,
    );
    if (!entry) {
      throw new Error(
        `Created codex entry ${result.entityId} not found after reload`,
      );
    }
    return entry;
  };
  if (input.content !== undefined) {
    return runTimelapseBodyReplacement(
      {
        projectId,
        documentIdentity: {
          projectId,
          domain: "codex",
          entityType: "codex_entry",
          entityId: entryId,
        },
      },
      { commit: write, project: async (entry) => entry },
    );
  }
  return runTimelapseMutation(projectId, write);
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
    throw new AiPolicyWriteBlockedError("knowledgeWrite");
  }

  const projectId = options?.writeOpts?.projectId ?? getCurrentProjectId();
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

  const write = async (): Promise<CodexEntry> => {
    const before = useCodexStore
      .getState()
      .entries.find((e) => e.id === input.entryId);
    if (!before) {
      throw new Error(`Codex entry ${input.entryId} not found`);
    }
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
        authorshipSpanLanes: authorshipSpans
          ? spanLanes(authorshipSpans)
          : null,
      },
    });
    const entry = await projectCodexWrite(
      "update_codex_entry",
      projectId,
      result.entityId,
      result.undoJournalId,
      input.name !== undefined || input.aliases !== undefined,
    );
    if (!entry) {
      throw new Error(
        `Updated codex entry ${result.entityId} not found after reload`,
      );
    }
    return entry;
  };
  if (input.content !== undefined) {
    return runTimelapseBodyReplacement(
      {
        projectId,
        documentIdentity: {
          projectId,
          domain: "codex",
          entityType: "codex_entry",
          entityId: input.entryId,
        },
      },
      { commit: write, project: async (entry) => entry },
    );
  }
  return runTimelapseMutation(projectId, write);
}
