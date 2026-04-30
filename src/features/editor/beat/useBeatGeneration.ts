import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { buildBeatMessages, type BeatPromptInput } from "./beatPromptBuilder";
import {
  appendBeatChunk,
  ensureGeneratedBlock,
  findBeatById,
} from "./insertBeatStream";
import type { BeatType } from "@/features/editor/SceneBeatNode";

const DEFAULT_MODEL = "claude-sonnet-4-6";

export type BeatGenerationStatus = "idle" | "generating" | "error";

export interface BeatGenerationState {
  status: BeatGenerationStatus;
  error: string | null;
  /** Active stream cleanup; calling it stops listening (does not abort backend). */
  cleanup: (() => void) | null;
}

const INITIAL_STATE: BeatGenerationState = {
  status: "idle",
  error: null,
  cleanup: null,
};

/**
 * Hook for one Beat's generation lifecycle.
 *
 * Reads scene context from stores, builds prompts via beatPromptBuilder,
 * streams via the existing inline-ai Tauri pipeline, and writes chunks into
 * the linked generatedProseBlock with AuthorshipMark='ai'.
 *
 * Each call to `generate()` creates (or reuses) the generatedProseBlock and
 * appends streaming text. Regenerate is NOT handled here — that's Slice 3c.
 */
export function useBeatGeneration(
  editor: Editor | null,
  beatId: string,
  sceneId: string | null,
) {
  const [state, setState] = useState<BeatGenerationState>(INITIAL_STATE);
  // Single source of truth for the active stream's cleanup. Held in a ref so
  // onDone / onError / re-entrant generate() can read+clear it without going
  // through React state (which is async and would race with chunk events).
  const cleanupRef = useRef<(() => void) | null>(null);
  // In-flight guard: synchronously prevents a double-click from registering
  // two parallel listeners while React is still flushing the "generating"
  // state update.
  const inFlightRef = useRef(false);

  const releaseCleanup = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    inFlightRef.current = false;
  }, []);

  // Tear down active listeners when the NodeView unmounts (otherwise a beat
  // deleted mid-stream leaves event listeners alive forever).
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      inFlightRef.current = false;
    };
  }, []);

  const generate = useCallback(async () => {
    if (!editor || !sceneId) return;
    if (inFlightRef.current) return;

    const beat = findBeatById(editor, beatId);
    if (!beat) return;

    const beatNode = editor.state.doc.nodeAt(beat.beatPos);
    if (!beatNode) return;

    const instructions = beatNode.textContent;
    if (instructions.trim().length === 0) {
      setState({
        status: "error",
        error: "Beat has no instructions",
        cleanup: null,
      });
      return;
    }

    const beatType = (beatNode.attrs.beatType ?? "free") as BeatType;
    const beatPov = (beatNode.attrs.pov ?? null) as string | null;

    // Resolve scene + project context from stores.
    const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
    const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
    const sceneTitle = node?.title ?? "";
    const codexEntries = useCodexStore.getState().entries;

    // POV: beat override > scene POV > null.
    const povCharId = beatPov ?? node?.povCharacterId ?? null;
    const povName = povCharId
      ? (codexEntries.find((e) => e.id === povCharId)?.name ?? null)
      : null;

    // sceneTextSoFar: doc text from start to the beat position (exclusive).
    const sceneTextSoFar = editor.state.doc.textBetween(
      0,
      beat.beatPos,
      "\n",
      " ",
    );

    const promptInput: BeatPromptInput = {
      instructions,
      beatType,
      projectTitle,
      sceneTitle,
      sceneTextSoFar,
      povName,
    };
    const messages = buildBeatMessages(promptInput);

    if (!ensureGeneratedBlock(editor, beatId)) return;

    // Belt-and-suspenders: if a previous stream somehow left a cleanup behind
    // (e.g. error path that bypassed releaseCleanup), unhook it now.
    cleanupRef.current?.();
    cleanupRef.current = null;

    const traceId = crypto.randomUUID();
    inFlightRef.current = true;
    setState({ status: "generating", error: null, cleanup: null });
    let orphaned = false;

    try {
      const cleanup = await sendInlineAiStream(messages, {
        onTextDelta: (delta) => {
          if (orphaned) return;
          // appendBeatChunk re-locates the block by beatId on every call,
          // so upstream edits don't drift the insertion point. If the block
          // (or its beat) has been deleted mid-stream, it returns false and
          // we stop applying further chunks.
          const ok = appendBeatChunk(editor, beatId, delta, {
            model: DEFAULT_MODEL,
            traceId,
          });
          if (!ok) {
            orphaned = true;
            releaseCleanup();
            setState({
              status: "error",
              error: "Beat was removed during generation",
              cleanup: null,
            });
          }
        },
        onDone: () => {
          if (orphaned) return;
          releaseCleanup();
          setState({ status: "idle", error: null, cleanup: null });
        },
        onError: (message) => {
          releaseCleanup();
          setState({ status: "error", error: message, cleanup: null });
        },
      });
      cleanupRef.current = cleanup;
      // If onDone fired between sendInlineAiStream resolving and us assigning
      // the cleanup ref above, it would have set cleanupRef to null already
      // and we'd just be storing a no-op. Still safe.
      setState((s) => (s.status === "generating" ? { ...s, cleanup } : s));
    } catch (err) {
      releaseCleanup();
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: "error", error: msg, cleanup: null });
    }
  }, [editor, beatId, sceneId, releaseCleanup]);

  const reset = useCallback(() => {
    releaseCleanup();
    setState(INITIAL_STATE);
  }, [releaseCleanup]);

  return {
    state,
    generate,
    reset,
  };
}
