import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { buildBeatMessages } from "./beatPromptBuilder";
import {
  appendBeatChunk,
  ensureGeneratedBlock,
  findBeatById,
} from "./insertBeatStream";
import type { BeatType } from "@/features/editor/SceneBeatNode";

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Fire-and-forget beat generation without React hook state.
 * Used by "Place at end and generate" from the Unplaced beat menu.
 * Errors are surfaced via toast rather than component state.
 */
export async function generateBeatOnce(
  editor: Editor,
  beatId: string,
  sceneId: string,
): Promise<void> {
  const beat = findBeatById(editor, beatId);
  if (!beat) return;

  const beatNode = editor.state.doc.nodeAt(beat.beatPos);
  if (!beatNode) return;

  const instructions = beatNode.textContent;
  if (instructions.trim().length === 0) return;

  const beatType = (beatNode.attrs.beatType ?? "free") as BeatType;
  const beatPov = (beatNode.attrs.pov ?? null) as string | null;
  const beatModel = (beatNode.attrs.model as string | null) ?? null;

  const node = useTreeStore.getState().nodes.find((n) => n.id === sceneId);
  const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
  const sceneTitle = node?.title ?? "";
  const codexEntries = useCodexStore.getState().entries;

  const povCharId = beatPov ?? node?.povCharacterId ?? null;
  const povName = povCharId
    ? (codexEntries.find((e) => e.id === povCharId)?.name ?? null)
    : null;

  const sceneTextSoFar = editor.state.doc.textBetween(
    0,
    beat.beatPos,
    "\n",
    " ",
  );

  const messages = buildBeatMessages({
    instructions,
    beatType,
    projectTitle,
    sceneTitle,
    sceneTextSoFar,
    povName,
  });

  if (!ensureGeneratedBlock(editor, beatId)) return;

  const traceId = crypto.randomUUID();
  // Holds the stop-stream callback once sendInlineAiStream resolves.
  // Callbacks fire after resolution, so this is always assigned by then.
  let stopStream: (() => void) | null = null;
  let orphaned = false;

  try {
    stopStream = await sendInlineAiStream(
      messages,
      {
        onTextDelta: (delta) => {
          if (orphaned) return;
          const ok = appendBeatChunk(editor, beatId, delta, {
            model: beatModel ?? DEFAULT_MODEL,
            traceId,
          });
          if (!ok) {
            orphaned = true;
            stopStream?.();
            stopStream = null;
          }
        },
        onDone: () => {
          stopStream = null;
        },
        onError: (message) => {
          stopStream = null;
          toast.error(message);
        },
      },
      beatModel ? { model: beatModel } : undefined,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error(msg);
  }
}
