import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import {
  buildPseudoCommentPayload,
  buildPseudoCommentSystemPrompt,
  personaDefsForLang,
  personaRequiresTargetProfile,
  personasForLang,
  PSEUDO_COMMENT_PROMPT_VERSION,
  resolvePersonaBrief,
} from "@/features/post-effect/pseudoCommentPayloadBuilder";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import { useCurrentProject } from "@/features/project/projectStore";
import {
  flushPendingSceneSaves,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";

interface Props {
  /** 実行完了時に呼ぶ。CommentsTab の annotation-only reload を渡す。 */
  onCompleted: () => Promise<void> | void;
}

/**
 * 疑似コメント（読者ペルソナによる本文横コメント）の実行導線。
 * ペルソナ選択 + 生成ボタンのみを持つ薄いヘッダ部品で、CommentsTab のヘッダに置く。
 * スレッド表示は CommentsTab が一元的に行うため、このコンポーネントは持たない
 * （旧 CurrentScenePseudoCommentView から実行部分だけを切り出したもの）。
 * 対象は常にアクティブシーン。シーン未選択時は生成ボタンを無効化する。
 */
export function PseudoCommentRunControl({ onCompleted }: Props) {
  const { t } = useTranslation();
  // project 言語で読者ペルソナ集合 (ja/en) と校閲プロンプトを切替える。
  const lang = useCurrentProject()?.language ?? "ja";
  const personaDefs = personaDefsForLang(lang);
  const personas = personasForLang(lang);
  // 対象は常にアクティブシーン。activeSceneId は string 既定("")なので falsy 判定。
  const sceneId = useTreeStore((s) => s.activeSceneId);
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
  const [persona, setPersona] = useState<string>(personas[0]);
  // genre は全ペルソナの brief に、targetReaders は「ターゲット読者層」ペルソナの
  // 実体として注入する。targetReaders 空のとき同ペルソナは選択不可にする。
  const [genre, setGenre] = useState<string | null>(null);
  const [targetReaders, setTargetReaders] = useState<string | null>(null);
  const analysisGate = useAiGate("analysis");

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  // genre / 想定読者プロフィールを取得 (ペルソナ brief 注入 + ターゲット読者層の
  // 選択可否判定)。project 単位の値なのでマウント時に 1 度だけ取る。
  useEffect(() => {
    let cancelled = false;
    void fetchProjectContext().then((ctx) => {
      if (cancelled) return;
      setGenre(ctx?.genre ?? null);
      setTargetReaders(ctx?.targetReaders ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const hasTargetProfile = Boolean(targetReaders?.trim());

  // 選択中ペルソナが (a) 現在の言語のペルソナ集合に存在しない (lang 切替) か、
  // (b) プロフィール必須かつ未設定 になったら、その言語の先頭ペルソナへ戻す。
  // 判定はレジストリ (personaDefsForLang) を単一の真実源にする。
  useEffect(() => {
    const list = personasForLang(lang);
    if (
      !list.includes(persona) ||
      (!hasTargetProfile && personaRequiresTargetProfile(persona, lang))
    ) {
      setPersona(list[0]);
    }
  }, [hasTargetProfile, persona, lang]);

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
  }, [running, sceneId, persona, genre, targetReaders, lang, t, onCompleted]);

  const disabled =
    running || !sceneId || analysisGate.presentation !== "enabled";

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={persona}
        onChange={(e) => setPersona(e.target.value)}
        className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
      >
        {personaDefs.map((d) => {
          const locked = Boolean(d.requiresTargetProfile) && !hasTargetProfile;
          return (
            <option
              key={d.label}
              value={d.label}
              disabled={locked}
              title={
                locked
                  ? t("kouetsu.pseudoComment.targetProfileRequired")
                  : undefined
              }
            >
              {locked
                ? `${d.label}${t("kouetsu.pseudoComment.requiresTargetProfile")}`
                : d.label}
            </option>
          );
        })}
      </select>
      {/* analysis がポリシーで OFF のときは生成ボタンを隠す（ペルソナ選択は残す）。 */}
      {analysisGate.presentation !== "hidden" && (
        <button
          type="button"
          disabled={disabled}
          title={
            !sceneId
              ? t("kouetsu.selectScene")
              : (analysisGate.tooltip ?? t("kouetsu.pseudoComment.runTooltip"))
          }
          onClick={() => void run()}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
            "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {running ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          <span>{t("kouetsu.pseudoComment.generateButton")}</span>
        </button>
      )}
    </div>
  );
}
