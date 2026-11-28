import i18next from "i18next";
import { invoke } from "@/lib/tauri";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { AiPolicyWriteBlockedError } from "@/features/ai-policy/writeBlockedError";
import { getRecorderSessionId } from "@/features/timelapse/recorder";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import {
  extractAiSpansFromPmJson,
  type AgentAuthorshipSpanInput,
} from "./authorshipSpans";
import { markCodexContentAsAi } from "./codex";
import { pushCommittedWriteHistory } from "./committedWriteHistory";
import type { Snippet } from "@/features/snippets/api";
import {
  createCanonicalWriteContext,
  type CanonicalWriteAuthorityOptions,
} from "@/features/native-writes/writeContext";
import {
  runTimelapseBodyReplacement,
  runTimelapseMutation,
} from "@/features/timelapse/bodyWriteMode";

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

export async function projectSnippetWrite(
  projectId: string,
  entityId: string,
  journalId: string,
  isCurrent?: () => boolean,
): Promise<Snippet | undefined> {
  if (isCurrent && !isCurrent()) return;
  const registerUndo = () => {
    pushCommittedWriteHistory(
      projectId,
      {
        kind: "snippets",
        label: i18next.t("snippets.store.agentHistoryCreate"),
        operationId: journalId,
        entityId,
      },
      (isProjectCurrent) =>
        useSnippetStore
          .getState()
          .loadEntries({ afterWrite: isProjectCurrent }),
    );
  };
  // The verified Native journal remains undoable even if this view cannot refresh.
  if (isCurrent) registerUndo();
  await useSnippetStore
    .getState()
    .loadEntries(
      isCurrent ? { afterWrite: isCurrent, propagateError: true } : undefined,
    );
  if (isCurrent && !isCurrent()) return;
  const entry = useSnippetStore
    .getState()
    .entries.find((item) => item.id === entityId);
  if (!isCurrent && entry) registerUndo();
  return entry;
}

export async function agentCreateSnippet(
  input: AgentSnippetCreateInput,
  chatMessageId?: string | null,
  authority?: Pick<
    CanonicalWriteAuthorityOptions,
    | "agentAuthorityCapability"
    | "chatMessageId"
    | "toolCallId"
    | "executionId"
    | "mainOwnedProvenanceId"
  >,
): Promise<Snippet> {
  if (blockIfPolicyOff("knowledgeWrite")) {
    throw new AiPolicyWriteBlockedError("knowledgeWrite");
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
      authorityRoute: "interactive-agent-command",
      provenance: {
        requestId: input.requestId,
        traceId: input.traceId ?? chatMessageId ?? input.requestId,
        ...(chatMessageId ? { chatMessageId } : {}),
        ...(authority?.toolCallId ? { toolCallId: authority.toolCallId } : {}),
      },
      ...authority,
    },
  );

  const write = async (): Promise<Snippet> => {
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

    const entry = await projectSnippetWrite(
      projectId,
      result.entityId,
      result.undoJournalId,
    );
    if (!entry) {
      throw new Error(
        `Created snippet ${result.entityId} not found after reload`,
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
          domain: "snippet",
          entityType: "snippet",
          entityId: snippetId,
        },
      },
      { commit: write, project: async (entry) => entry },
    );
  }
  return runTimelapseMutation(projectId, write);
}
