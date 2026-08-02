import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import { isWriteRestrictedByLicense } from "@/features/license/gate";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { appendKouetsuGuidance } from "./customInstruction";
import {
  buildLivePseudoCommentPayload,
  buildLivePseudoCommentSystemPrompt,
  LIVE_PSEUDO_COMMENT_PROMPT_VERSION,
  resolvePersonaBrief,
} from "./pseudoCommentPayloadBuilder";
import { runPostEffect, type PostEffectRunCallbacks } from "./api";
import { getPromptCatalog } from "@/prompts/index";
import {
  cancelEditorAnalysisTask,
  scheduleEditorAnalysisTask,
} from "@/lib/editorAnalysisScheduler";
import {
  accumulateLiveReaderInsertion,
  classifyLiveReaderChange,
  createLiveReaderAccumulator,
  LIVE_READER_IDLE_DELAY_MS,
  shouldTriggerLiveReader,
  takeLiveReaderInsertion,
  type LiveReaderAccumulator,
} from "./liveReaderTrigger";
import { useLiveReaderStore } from "./liveReaderStore";

interface Params {
  editor: Editor | null;
  sceneId: string;
  enabled: boolean;
  persona: string;
  genre: string | null;
  targetReaders: string | null;
  lang: string;
}

let nextLiveReaderOwnerId = 0;

function editorText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
}

/**
 * 追記だけを低頻度で AI へ渡す本文側の接続。コメントは DB に保存せず
 * `useLiveReaderStore` に置き、シーン切替・置換・削除で寿命を終える。
 */
export function useLiveReaderComments({
  editor,
  sceneId,
  enabled,
  persona,
  genre,
  targetReaders,
  lang,
}: Params): void {
  const ownerIdRef = useRef<number | null>(null);
  const projectId = useTreeStore((state) => state.projectId);
  const aiSettingsReady = useAiSettingsStore(
    (state) => state.settings !== null,
  );
  if (ownerIdRef.current === null) ownerIdRef.current = ++nextLiveReaderOwnerId;

  useEffect(() => {
    if (!editor || !sceneId || !enabled) return;

    const taskKey = `live-reader:${sceneId}:${ownerIdRef.current}`;
    const clearScene = useLiveReaderStore.getState().clearScene;
    const addComment = useLiveReaderStore.getState().addComment;
    let previousText = editorText(editor);
    let accumulator: LiveReaderAccumulator = createLiveReaderAccumulator();
    let sourceRevision = 0;
    let activeRun = false;
    let activeCleanup: (() => void) | null = null;
    let disposed = false;

    const maybeScheduleNext = () => {
      if (!disposed && !activeRun && shouldTriggerLiveReader(accumulator)) {
        scheduleEditorAnalysisTask({
          key: taskKey,
          kind: "live-reader",
          delayMs: LIVE_READER_IDLE_DELAY_MS,
          run: launch,
          onError: (error) => {
            console.warn("live reader scheduler failed", error);
          },
        });
      }
    };

    const launch = async (): Promise<void> => {
      if (disposed || activeRun || !shouldTriggerLiveReader(accumulator)) {
        return;
      }
      if (
        isAiFeatureBlockedByPolicy("analysis") ||
        isWriteRestrictedByLicense()
      ) {
        accumulator = createLiveReaderAccumulator();
        return;
      }

      const settings = useAiSettingsStore.getState().settings;
      if (!projectId || !settings) return;

      const { text: addedText, next } = takeLiveReaderInsertion(accumulator);
      accumulator = next;
      const sourceText = editorText(editor);
      const capturedRevision = sourceRevision;
      const override = resolveRoleSendOverride("post_effect_pseudo_comment");
      const model = override.model ?? settings.model ?? "gpt-4o-mini";
      const customInstruction = useSettingsStore
        .getState()
        .get("aiPrompt.custom.kouetsu", "");
      const brief = resolvePersonaBrief(
        persona,
        { genre, targetReaders },
        lang,
      );

      activeRun = true;
      try {
        const payload = await buildLivePseudoCommentPayload(
          sourceText,
          addedText,
          model,
          persona,
          brief,
          customInstruction,
          { provider: override.provider, endpointId: override.endpointId },
        );

        const callbacks: PostEffectRunCallbacks = {
          onPartial: (event) => {
            // 生成中に次の追記・置換があった結果は、現在の本文へ誤結び付けしない。
            if (
              disposed ||
              capturedRevision !== sourceRevision ||
              sourceText !== editorText(editor)
            ) {
              return;
            }
            const live = event.live_comment;
            if (!live) return;
            addComment({
              id: event.annotation_id,
              runId: event.run_id,
              sceneId,
              content: live.content,
              persona: live.persona ?? null,
              foundText: live.found_text ?? "",
              foundContext: live.found_context ?? "",
              createdAt: Date.now(),
            });
          },
          onDone: () => {
            activeRun = false;
            activeCleanup = null;
            maybeScheduleNext();
          },
          onError: (event) => {
            activeRun = false;
            activeCleanup = null;
            console.warn("live reader generation failed", event.error);
            maybeScheduleNext();
          },
        };

        const started = await runPostEffect(
          {
            project_id: projectId,
            effect_type: "pseudo_comment",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            model_override: override.model,
            provider_override: override.provider,
            api_variant_override: override.apiVariant,
            endpoint_id_override: override.endpointId,
            prompt_version: LIVE_PSEUDO_COMMENT_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: buildLivePseudoCommentSystemPrompt(
              appendKouetsuGuidance(
                getPromptCatalog(lang).postEffect.pseudoCommentSystem,
                customInstruction,
              ),
              brief,
            ),
            persona,
            live: true,
          },
          callbacks,
        );
        activeCleanup = started.cleanup;
      } catch (error) {
        activeRun = false;
        activeCleanup = null;
        console.warn("live reader launch failed", error);
        maybeScheduleNext();
      }
    };

    const handleUpdate = ({
      transaction,
    }: {
      transaction: { docChanged: boolean; getMeta: (key: string) => unknown };
    }) => {
      if (!transaction.docChanged) return;
      sourceRevision += 1;
      const nextText = editorText(editor);
      const change = classifyLiveReaderChange(previousText, nextText, {
        docChanged: transaction.docChanged,
        isComposing: editor.view.composing,
        isProgrammatic:
          transaction.getMeta("programmaticInsert") === true ||
          transaction.getMeta("externalUpdate") === true,
      });
      previousText = nextText;

      if (change.kind === "insert") {
        accumulator = accumulateLiveReaderInsertion(
          accumulator,
          change.addedText,
        );
        if (shouldTriggerLiveReader(accumulator)) maybeScheduleNext();
        return;
      }

      if (change.kind === "delete" || change.kind === "replace") {
        accumulator = createLiveReaderAccumulator();
        cancelEditorAnalysisTask(taskKey);
        clearScene(sceneId);
      }
    };

    editor.on("update", handleUpdate);
    return () => {
      disposed = true;
      editor.off("update", handleUpdate);
      cancelEditorAnalysisTask(taskKey);
      activeCleanup?.();
      activeCleanup = null;
      clearScene(sceneId);
    };
  }, [
    editor,
    sceneId,
    enabled,
    persona,
    genre,
    targetReaders,
    lang,
    projectId,
    aiSettingsReady,
  ]);
}
