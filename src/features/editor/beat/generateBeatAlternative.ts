import type { Editor } from "@tiptap/core";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { getProject } from "@/features/project/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { streamInlineAiText } from "./streamInlineAiText";
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
  // 兄弟経路 (generateBeatOnce / useBeatGeneration) と同じ L0 ゲート。
  // ここに無いと制限中でも AI 課金だけ走り、保存 (snippetStore.create) で
  // throw して結果が捨てられる。
  if (blockIfPolicyOff("bodyWrite")) return;
  if (blockIfUnlicensed()) return;

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
  let project;
  try {
    project = await getProject(useTreeStore.getState().projectId);
  } catch {
    // ignore
  }
  const lang = project?.language ?? "ja";

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
    lang,
    customInstruction: useSettingsStore
      .getState()
      .get("aiPrompt.custom.beat", ""),
  });

  callbacks?.onStart?.();

  const result = await streamInlineAiText(messages, {
    model: beatModel ?? undefined,
    usageSurface: "beat",
  });
  if (!result.ok) {
    callbacks?.onError?.(result.error);
    return;
  }

  const content = result.text;
  const preview = content.replace(/\n/g, " ").slice(0, 40).trimEnd();
  const title =
    preview.length < content.replace(/\n/g, " ").length
      ? `${preview}…`
      : preview || instructions.slice(0, 40);

  try {
    await useSnippetStore
      .getState()
      .create({ title, content, sceneId, contentSource: "ai" });
    callbacks?.onDone?.();
  } catch {
    callbacks?.onError?.("スニペットの保存に失敗しました");
  }
}
