import i18next from "i18next";
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
import { createCanonicalWriteContext } from "@/features/native-writes/writeContext";

export interface AgentSnippetCreateInput {
  /** Stable identity of the logical request; distinct from the created entity. */
  requestId: string;
  /** Reuse this domain ID when retrying the same logical create. */
  snippetId?: string;
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
  if (input.requestId.trim().length === 0) {
    throw new Error("requestId must be a non-empty string");
  }

  const projectId = getCurrentProjectId();
  const snippetId = input.snippetId ?? `snippet:${input.requestId}`;
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
  const authorityContext = createCanonicalWriteContext(
    "ai-apply",
    undefined,
    input.requestId,
    {
      provenance: {
        requestId: input.requestId,
        traceId: input.traceId ?? input.requestId,
        ...(chatMessageId ? { chatMessageId } : {}),
      },
    },
  );

  const result = await invoke<AgentWriteResult>("agent_snippet_create", {
    payload: {
      ...authorityContext,
      requestId: input.requestId,
      snippetId,
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
      label: i18next.t("snippets.store.agentHistoryCreate"),
      operationId: journalId,
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
