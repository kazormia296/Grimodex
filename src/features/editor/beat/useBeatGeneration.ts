import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { buildBeatMessages, type BeatPromptInput } from "./beatPromptBuilder";
import {
  appendBeatChunk,
  ensureGeneratedBlock,
  findBeatById,
  findGeneratedBlockForBeat,
} from "./insertBeatStream";
import type { BeatType } from "@/features/editor/SceneBeatNode";
import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import { buildPendingBeatsSection } from "./pendingBeatsContext";
import { inferMentionRoles } from "./inferMentionRoles";
import { extractBeatMentions } from "./extractBeatMentions";
import { useRoleSuggestionsStore } from "./roleSuggestionsStore";
import type { RoleSuggestionEntry } from "./roleSuggestionsStore";

const DEFAULT_MODEL = "claude-sonnet-4-6";

async function runRoleInference(
  editor: Editor,
  beatId: string,
  instructions: string,
): Promise<void> {
  const settings = useSettingsStore.getState();
  if (!settings.getBoolean("beat.inferRoles", true)) return;

  // Get the generated prose for this beat.
  const block = findGeneratedBlockForBeat(editor, beatId);
  if (!block) return;
  const blockNode = editor.state.doc.nodeAt(block.blockPos);
  if (!blockNode) return;
  const generatedProse = editor.state.doc.textBetween(
    block.blockPos,
    block.blockPos + block.blockSize,
    "\n",
    " ",
  );
  if (!generatedProse.trim()) return;

  // Extract @mentions from this beat.
  const allMentions = extractBeatMentions(editor.state.doc);
  const beatMentions = allMentions.filter((m) => m.beatId === beatId);
  if (beatMentions.length === 0) return;

  // Resolve character names from codex.
  const codexEntries = useCodexStore.getState().entries;
  const mentions = beatMentions.map((m) => ({
    codexId: m.codexId,
    name: codexEntries.find((e) => e.id === m.codexId)?.name ?? m.codexId,
    currentRole: m.role,
  }));

  const suggestions = await inferMentionRoles({
    beatInstructions: instructions,
    generatedProse,
    mentions,
  });

  // Apply confidence threshold and exclude same-role suggestions.
  const threshold = settings.getNumber(
    "beat.roleInferenceConfidenceThreshold",
    0.7,
  );
  const filtered = suggestions.filter(
    (s) =>
      s.confidence >= threshold &&
      s.role !== beatMentions.find((m) => m.codexId === s.codexId)?.role,
  );
  if (filtered.length === 0) return;

  // Orphan check: beat must still exist in doc.
  if (!findBeatById(editor, beatId)) return;

  const entries: RoleSuggestionEntry[] = filtered.map((s) => {
    const bm = beatMentions.find((m) => m.codexId === s.codexId)!;
    return {
      codexId: s.codexId,
      name: codexEntries.find((e) => e.id === s.codexId)?.name ?? s.codexId,
      currentRole: bm.role,
      suggestedRole: s.role,
      confidence: s.confidence,
      status: "pending",
    };
  });

  useRoleSuggestionsStore.getState().setSuggestions(beatId, entries);
}

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

    // C-2: Build "pending beats" section if injection is enabled.
    const injectEnabled = useSettingsStore
      .getState()
      .getBoolean("beat.injectIntoContext", true);
    let pendingBeatsSection: string | undefined;
    if (injectEnabled) {
      const unplacedBeats = useUnplacedBeatsStore.getState().getBeats(sceneId);
      pendingBeatsSection = buildPendingBeatsSection({
        sceneDocJson: editor.state.doc.toJSON(),
        unplacedBeats,
        resolveCharacterName: (id) =>
          codexEntries.find((e) => e.id === id)?.name ?? null,
        currentBeatId: beatId,
        scenePovCharacterId: node?.povCharacterId ?? null,
      });
    }

    const promptInput: BeatPromptInput = {
      instructions,
      beatType,
      projectTitle,
      sceneTitle,
      sceneTextSoFar,
      povName,
      pendingBeatsSection,
    };
    const messages = buildBeatMessages(promptInput);

    if (!ensureGeneratedBlock(editor, beatId)) return;

    // Belt-and-suspenders: if a previous stream somehow left a cleanup behind
    // (e.g. error path that bypassed releaseCleanup), unhook it now.
    cleanupRef.current?.();
    cleanupRef.current = null;

    const beatModel = (beatNode.attrs.model as string | null) ?? null;
    const resolvedModel = beatModel || null;

    const traceId = crypto.randomUUID();
    inFlightRef.current = true;
    setState({ status: "generating", error: null, cleanup: null });
    let orphaned = false;

    try {
      const cleanup = await sendInlineAiStream(
        messages,
        {
          onTextDelta: (delta) => {
            if (orphaned) return;
            // appendBeatChunk re-locates the block by beatId on every call,
            // so upstream edits don't drift the insertion point. If the block
            // (or its beat) has been deleted mid-stream, it returns false and
            // we stop applying further chunks.
            const ok = appendBeatChunk(editor, beatId, delta, {
              model: resolvedModel ?? DEFAULT_MODEL,
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
            runRoleInference(editor, beatId, instructions).catch((err) => {
              console.warn("role inference failed", err);
            });
          },
          onError: (message) => {
            releaseCleanup();
            setState({ status: "error", error: message, cleanup: null });
          },
        },
        resolvedModel ? { model: resolvedModel } : undefined,
      );
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
