import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  extractAiSpansFromPmJson,
  type AgentAuthorshipSpanInput,
} from "./authorshipSpans";
import { markCodexContentAsAi } from "./codex";
import { applyUndoJournal } from "./undoJournal";
import type { Snippet } from "@/features/snippets/api";

export interface AgentSnippetCreateInput {
  title: string;
  content?: string;
  sceneId?: string;
  sourceChatMessageId?: string;
  model?: string | null;
  traceId?: string | null;
}

interface AgentWriteResult {
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}

export async function agentCreateSnippet(
  input: AgentSnippetCreateInput,
  chatMessageId?: string | null,
): Promise<Snippet> {
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

  const authorshipSpans: AgentAuthorshipSpanInput[] = content
    ? extractAiSpansFromPmJson(content, {
        model: input.model,
        chatMessageId,
        traceId: input.traceId,
      })
    : [];

  const result = await invoke<AgentWriteResult>("agent_snippet_create", {
    payload: {
      projectId,
      sessionId: getRecorderSessionId(),
      title: input.title,
      content: content ?? null,
      sceneId: input.sceneId ?? null,
      sourceChatMessageId: input.sourceChatMessageId ?? chatMessageId ?? null,
      model: input.model ?? null,
      chatMessageId: chatMessageId ?? null,
      traceId: input.traceId ?? null,
      authorshipSpans,
    },
  });

  await useSnippetStore.getState().loadEntries();

  const entry = useSnippetStore
    .getState()
    .entries.find((e) => e.id === result.entityId);
  if (!entry) {
    throw new Error(
      `Created snippet ${result.entityId} not found after reload`,
    );
  }

  if (!useGlobalHistoryStore.getState().isReplaying) {
    const journalId = result.undoJournalId;
    const entityId = result.entityId;
    useGlobalHistoryStore.getState().push({
      kind: "snippets",
      label: "Agent: Snippet作成",
      entityId,
      async undo() {
        await applyUndoJournal(journalId, "undo");
        await useSnippetStore.getState().loadEntries();
      },
      async redo() {
        await applyUndoJournal(journalId, "redo");
        await useSnippetStore.getState().loadEntries();
      },
    });
  }

  return entry;
}
