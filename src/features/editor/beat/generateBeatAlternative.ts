import type { Editor } from "@tiptap/core";
import i18next from "@/lib/i18n";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { streamInlineAiText } from "./streamInlineAiText";
import { buildBeatMessages } from "./beatPromptBuilder";
import { buildBeatContextForGeneration } from "./buildBeatContext";

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

  const ctxResult = await buildBeatContextForGeneration(
    editor,
    beatId,
    sceneId,
  );
  if (!ctxResult.ok) return;
  const ctx = ctxResult.ctx;
  const { instructions, beatType, beatModel } = ctx;

  const messages = buildBeatMessages({
    instructions,
    beatType,
    projectTitle: ctx.projectTitle,
    sceneTitle: ctx.sceneTitle,
    sceneTextSoFar: ctx.sceneTextSoFar,
    povName: ctx.povName,
    lang: ctx.lang,
    codexSummaries: ctx.codexSummaries,
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
    callbacks?.onError?.(i18next.t("common.snippetSaveFailed"));
  }
}
