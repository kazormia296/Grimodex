import type { Editor } from "@tiptap/core";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { sendInlineAiStream } from "@/features/editor/inlineAi/inlineAiStreaming";

interface GenerateSynopsisCallbacks {
  onStart?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

/**
 * Collect all placed beat instructions, send to AI, and write the result
 * back to the scene's synopsis field via useTreeStore.updateSynopsis.
 */
export async function generateSynopsisFromBeats(
  editor: Editor,
  sceneId: string,
  callbacks?: GenerateSynopsisCallbacks,
): Promise<void> {
  const beatInstructions: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "sceneBeat") {
      const text = node.textContent.trim();
      if (text) beatInstructions.push(text);
      return false;
    }
    return true;
  });

  if (beatInstructions.length === 0) return;

  const state = useTreeStore.getState();
  const treeNode = state.nodes.find((n) => n.id === sceneId);
  const projectTitle = useWorkspaceStore.getState().activeWorkspaceName ?? "";
  const sceneTitle = treeNode?.title ?? "";

  const beatList = beatInstructions
    .map((instr, i) => `${i + 1}. ${instr}`)
    .join("\n");

  const messages: { role: string; content: string }[] = [
    {
      role: "system",
      content: `あなたは小説執筆アシスタントです。プロジェクト「${projectTitle}」のシーン「${sceneTitle}」のビートリストから、簡潔なシノプシスを1〜3文で生成します。`,
    },
    {
      role: "user",
      content: `以下のビートリストを元に、このシーンのシノプシスを1〜3文で書いてください。本文は書かず、要約のみ出力してください。\n\n## ビートリスト\n${beatList}`,
    },
  ];

  callbacks?.onStart?.();

  const buffer: string[] = [];

  await new Promise<void>((resolve) => {
    sendInlineAiStream(messages, {
      onTextDelta: (delta) => {
        buffer.push(delta);
      },
      onDone: () => {
        const synopsis = buffer.join("").trim();
        useTreeStore
          .getState()
          .updateSynopsis(sceneId, synopsis)
          .then(() => {
            callbacks?.onDone?.();
            resolve();
          })
          .catch(() => {
            callbacks?.onError?.("シノプシスの保存に失敗しました");
            resolve();
          });
      },
      onError: (message) => {
        callbacks?.onError?.(message);
        resolve();
      },
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      callbacks?.onError?.(msg);
      resolve();
    });
  });
}
