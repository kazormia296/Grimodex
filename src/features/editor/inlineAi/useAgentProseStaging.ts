import { useEffect, useCallback } from "react";
import type { Editor } from "@tiptap/core";
import { useProseStagingStore } from "@/features/agent-writes/proseStagingStore";
import {
  agentAcceptProseStage,
  agentDiscardProseStage,
  loadLatestProposedProse,
} from "@/features/agent-writes/prose";
import { useInlineAiStore } from "./inlineAiStore";

interface InlineAiDiffApi {
  showProvidedText: (
    text: string,
    opts: {
      mode: "insert" | "replace";
      stagingId?: string;
      originalRange?: { from: number; to: number };
      insertPos?: number;
      model?: string;
    },
  ) => void;
  accept: () => void;
  rejectOrAbort: () => void;
  getActiveStagingId: () => string | null;
}

/**
 * Bridges agent/MCP prose_staging proposals into the inline-AI diff accept/reject UI.
 */
export function useAgentProseStaging(
  editor: Editor | null,
  sceneId: string | null,
  diffApi: InlineAiDiffApi,
) {
  const pending = useProseStagingStore((s) => s.pending);
  const clearPending = useProseStagingStore((s) => s.clear);
  const enqueue = useProseStagingStore((s) => s.enqueue);

  useEffect(() => {
    if (!sceneId) return;
    let cancelled = false;
    void loadLatestProposedProse(sceneId).then((proposal) => {
      if (cancelled || !proposal) return;
      if (useInlineAiStore.getState().status !== "idle") return;
      enqueue(proposal);
    });
    return () => {
      cancelled = true;
    };
  }, [sceneId, enqueue]);

  useEffect(() => {
    if (!editor || !sceneId || !pending || pending.sceneId !== sceneId) return;
    if (useInlineAiStore.getState().status !== "idle") return;

    const { stagingId, text, mode, replaceFrom, replaceTo } = pending;
    clearPending();

    if (mode === "replace" && replaceFrom != null && replaceTo != null) {
      diffApi.showProvidedText(text, {
        mode: "replace",
        stagingId,
        originalRange: { from: replaceFrom, to: replaceTo },
      });
      return;
    }

    const insertPos =
      mode === "insert"
        ? editor.state.selection.from
        : editor.state.doc.content.size;

    diffApi.showProvidedText(text, {
      mode: "insert",
      stagingId,
      insertPos,
    });
  }, [editor, sceneId, pending, clearPending, diffApi]);

  const acceptWithStaging = useCallback(async () => {
    const stagingId = diffApi.getActiveStagingId();
    if (stagingId) {
      try {
        await agentAcceptProseStage(stagingId);
      } catch (err) {
        console.warn("[proseStaging] accept finalize failed", err);
        return;
      }
    }
    diffApi.accept();
  }, [diffApi]);

  const rejectWithStaging = useCallback(async () => {
    const stagingId = diffApi.getActiveStagingId();
    if (stagingId) {
      try {
        await agentDiscardProseStage(stagingId);
      } catch (err) {
        console.warn("[proseStaging] discard finalize failed", err);
      }
    }
    diffApi.rejectOrAbort();
  }, [diffApi]);

  return { acceptWithStaging, rejectWithStaging };
}
