import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildPseudoCommentPayload,
  buildPseudoCommentSystemPrompt,
  PSEUDO_COMMENT_PROMPT_VERSION,
  resolvePersonaBrief,
} from "@/features/post-effect/pseudoCommentPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";

interface Params {
  /** 対象は常にアクティブシーン。"" (未選択) のときは実行しない。 */
  sceneId: string;
  persona: string;
  genre: string | null;
  targetReaders: string | null;
  lang: string;
  /** 実行完了時に呼ぶ。CommentsTab の annotation-only reload を渡す。 */
  onCompleted: () => Promise<void> | void;
}

/**
 * 疑似コメント生成の実行ロジック（payload 構築〜invoke〜完了後の反映）を
 * カプセル化するフック。PseudoCommentRunControl から抽出（挙動は不変）。
 * `running` は runStore 由来の実行中判定 (launching || storeRunning) を返す。
 */
export function usePseudoCommentRun({
  sceneId,
  persona,
  genre,
  targetReaders,
  lang,
  onCompleted,
}: Params): { running: boolean; run: () => Promise<void> } {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  // sceneId が "" (未選択) のときはどの run にも一致しない (run は実 scene id
  // でのみ begin される)。undefined を渡すと「scene の任意 run」に一致して
  // 未選択時に他シーンの spinner を拾うため、そのまま渡す。
  const storeRunning = useIsPostEffectRunning(
    "pseudo_comment",
    "scene",
    sceneId,
  );
  const running = launching || storeRunning;
  const { setAnnotations } = useAnnotationStore();

  const run = useCallback(async () => {
    if (running || !sceneId) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const projectId = useTreeStore.getState().projectId;
    const ov = resolveRoleSendOverride("post_effect_pseudo_comment");
    const model =
      ov.model ??
      useAiSettingsStore.getState().settings?.model ??
      "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    setLaunching(true);
    try {
      await flushPendingSceneSaves(sceneId);
      // brief を 1 度だけ解決し、hash (payload) と system_prompt で同じものを使う。
      const brief = resolvePersonaBrief(
        persona,
        { genre, targetReaders },
        lang,
      );
      const payload = await buildPseudoCommentPayload(
        sceneId,
        model,
        persona,
        brief,
        customKouetsu,
        { provider: ov.provider, endpointId: ov.endpointId },
      );
      const outcome = await new Promise<{
        ok: boolean;
        e?: PostEffectDoneEvent;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "pseudo_comment",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            model_override: ov.model,
            provider_override: ov.provider,
            api_variant_override: ov.apiVariant,
            endpoint_id_override: ov.endpointId,
            prompt_version: PSEUDO_COMMENT_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            // custom は区切り行の前 (appendKouetsuGuidance)、READER PERSONA は
            // JSON スキーマの後 (buildPseudoCommentSystemPrompt) に入る。
            system_prompt: buildPseudoCommentSystemPrompt(
              appendKouetsuGuidance(
                getPromptCatalog(lang).postEffect.pseudoCommentSystem,
                customKouetsu,
              ),
              brief,
            ),
            persona,
          },
          {
            onDone: (e) => resolve({ ok: true, e }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      // 生成後、対象シーンの annotation を再取得して annotationStore と本文の
      // peAnnotation ハイライトを同期する。移設元 CurrentScenePseudoCommentView
      // の reload() が担っていた scene 単位更新の復元（CommentsTab の
      // annotation-only reload = onCompleted はスレッド表示のみで、本文
      // ハイライトと scene ストアは更新しないため両方必要）。editor 未取得
      // (null) 時は applyAnnotationsToEditor が no-op（EditorPane 側で最新を保つ）。
      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);

      await onCompleted();
      setLaunching(false);

      if (!outcome.ok) {
        postEffectErrorToast(
          t("kouetsu.pseudoComment.generationFailed"),
          outcome.error,
        );
        return;
      }
      if (outcome.e?.from_cache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if ((outcome.e?.annotation_count ?? 0) === 0) {
        toast.success(t("kouetsu.pseudoComment.noComments"));
      }
    } catch (e) {
      console.error("pseudo_comment launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.pseudoComment.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [
    running,
    sceneId,
    persona,
    genre,
    targetReaders,
    lang,
    t,
    onCompleted,
    setAnnotations,
  ]);

  return { running, run };
}
