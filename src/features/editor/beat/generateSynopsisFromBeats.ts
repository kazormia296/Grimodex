import type { Editor } from "@tiptap/core";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { streamInlineAiText } from "./streamInlineAiText";
import { getPromptCatalog } from "@/prompts/index";
import { getProject } from "@/features/project/api";
import i18next from "@/lib/i18n";

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
  let project;
  try {
    project = await getProject(state.projectId);
  } catch {
    // ignore
  }
  const lang = project?.language ?? "ja";

  const beatList = beatInstructions
    .map((instr, i) => `${i + 1}. ${instr}`)
    .join("\n");

  const messages = getPromptCatalog(
    lang,
  ).beatGenerate.buildGenerateSynopsisMessages(
    projectTitle,
    sceneTitle,
    beatList,
  );

  callbacks?.onStart?.();

  const result = await streamInlineAiText(messages, {
    usageSurface: "synopsis",
    projectId: state.projectId,
    auditPathId: "synopsis_from_beats",
  });
  if (!result.ok) {
    callbacks?.onError?.(result.error);
    return;
  }
  const synopsis = result.text.trim();
  if (!synopsis) {
    callbacks?.onError?.(i18next.t("beat.generateSynopsis.emptyResponse"));
    return;
  }
  try {
    await useTreeStore.getState().updateSynopsis(sceneId, synopsis);
    callbacks?.onDone?.();
  } catch {
    callbacks?.onError?.(i18next.t("beat.generateSynopsis.saveFailed"));
  }
}
