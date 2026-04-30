import type { Editor } from "@tiptap/core";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";
import { buildBeatMessages } from "./beatPromptBuilder";
import { findBeatById } from "./insertBeatStream";
import type { BeatType } from "@/features/editor/SceneBeatNode";

interface GenerateBeatAlternativeCallbacks {
  onStart?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * Stream a beat alternative and save the result as a Snippet.
 * Does NOT touch the editor's generatedProseBlock — the existing prose stays.
 */
export async function generateBeatAlternative(
  editor: Editor,
  beatId: string,
  sceneId: string,
  callbacks?: GenerateBeatAlternativeCallbacks,
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

  callbacks?.onStart?.();

  const buffer: string[] = [];

  await new Promise<void>((resolve) => {
    sendInlineAiStream(
      messages,
      {
        onTextDelta: (delta) => {
          buffer.push(delta);
        },
        onDone: () => {
          const content = buffer.join("");
          const preview = content.replace(/\n/g, " ").slice(0, 40).trimEnd();
          const title =
            preview.length < content.replace(/\n/g, " ").length
              ? `${preview}…`
              : preview || instructions.slice(0, 40);

          useSnippetStore
            .getState()
            .create({ title, content, sceneId, contentSource: "ai" })
            .then(() => {
              callbacks?.onDone?.();
              resolve();
            })
            .catch(() => {
              callbacks?.onError?.("スニペットの保存に失敗しました");
              resolve();
            });
        },
        onError: (message) => {
          callbacks?.onError?.(message);
          resolve();
        },
      },
      beatModel ? { model: beatModel } : undefined,
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks?.onError?.(msg);
      resolve();
    });
  });
}
