import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { deleteCodexEntry } from "@/features/codex/api";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { aiAuthorshipAttrs } from "@/features/attribution/aiAuthorship";
import {
  extractAiSpansFromPmJson,
  syntheticAiSpans,
  type AgentAuthorshipSpanInput,
} from "./authorshipSpans";
import type { CodexEntry } from "@/features/codex/api";

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

/** Apply AI authorship marks to a PM JSON content string before persistence. */
export function markCodexContentAsAi(
  contentJson: string,
  opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  } = {},
): string {
  if (!contentJson || contentJson === "{}") return contentJson;
  try {
    const doc = JSON.parse(contentJson) as Record<string, unknown>;
    const attrs = aiAuthorshipAttrs({
      model: opts.model,
      chatMessageId: opts.chatMessageId,
      traceId: opts.traceId,
    });
    applyAiMarkToDoc(doc, attrs);
    return JSON.stringify(doc);
  } catch {
    return contentJson;
  }
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

  const entry = useCodexStore
    .getState()
    .entries.find((e) => e.id === result.entityId);
  if (!entry) {
    throw new Error(
      `Created codex entry ${result.entityId} not found after reload`,
    );
  }

  if (!useGlobalHistoryStore.getState().isReplaying) {
    const captured = { ...entry };
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "Agent: Codex作成",
      async undo() {
        await deleteCodexEntry(projectId, captured.id);
        useCodexStore.setState((s) => ({
          entries: s.entries.filter((e) => e.id !== captured.id),
        }));
      },
      async redo() {
        await agentCreateCodexEntry(
          {
            type: captured.type,
            name: captured.name,
            summary: captured.summary ?? undefined,
            content: captured.content ?? undefined,
            aliases: captured.aliases ?? undefined,
            parentId: captured.parentId ?? undefined,
          },
          chatMessageId,
        );
      },
    });
  }

  return entry;
}

export async function agentUpdateCodexEntry(
  input: AgentCodexUpdateInput,
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

  const authorshipSpans =
    input.summary !== undefined || content !== undefined
      ? buildCodexAuthorshipSpans(
          { summary: input.summary, content },
          {
            model: input.model,
            chatMessageId,
            traceId: input.traceId,
          },
        )
      : undefined;

  const before = useCodexStore
    .getState()
    .entries.find((e) => e.id === input.entryId);

  const result = await invoke<AgentWriteResult>("agent_codex_update", {
    payload: {
      projectId,
      sessionId: getRecorderSessionId(),
      entryId: input.entryId,
      name: input.name ?? null,
      summary: input.summary ?? null,
      content: content ?? null,
      aliases: input.aliases ?? null,
      model: input.model ?? null,
      chatMessageId: chatMessageId ?? null,
      traceId: input.traceId ?? null,
      authorshipSpans: authorshipSpans ?? null,
    },
  });

  await useCodexStore.getState().loadEntries();

  const entry = useCodexStore
    .getState()
    .entries.find((e) => e.id === result.entityId);
  if (!entry) {
    throw new Error(
      `Updated codex entry ${result.entityId} not found after reload`,
    );
  }

  if (before && !useGlobalHistoryStore.getState().isReplaying) {
    const capturedBefore = { ...before };
    const patch = { ...input };
    useGlobalHistoryStore.getState().push({
      kind: "codex",
      label: "Agent: Codex更新",
      async undo() {
        await agentUpdateCodexEntry(
          {
            entryId: capturedBefore.id,
            name: capturedBefore.name,
            summary: capturedBefore.summary ?? undefined,
            content: capturedBefore.content ?? undefined,
            aliases: capturedBefore.aliases ?? undefined,
          },
          chatMessageId,
        );
      },
      async redo() {
        await agentUpdateCodexEntry(patch, chatMessageId);
      },
    });
  }

  return entry;
}
