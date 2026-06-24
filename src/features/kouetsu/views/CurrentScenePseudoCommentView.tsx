import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Info, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { useKouetsuStore } from "@/features/kouetsu/kouetsuStore";
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
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  groupPseudoThreads,
  PseudoCommentThread,
} from "@/features/post-effect/PseudoCommentThread";
import type { PostEffectDoneEvent } from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

export function CurrentScenePseudoCommentView({ sceneId }: Props) {
  const { t } = useTranslation();
  // project 言語で読者ペルソナ集合 (ja/en) と校閲プロンプトを切替える。
  const lang = useCurrentProject()?.language ?? "ja";
  const personaDefs = personaDefsForLang(lang);
  const personas = personasForLang(lang);
  const [running, setRunning] = useState(false);
  const [persona, setPersona] = useState<string>(personas[0]);
  // genre は全ペルソナの brief に、targetReaders は「ターゲット読者層」ペルソナの
  // 実体として注入する。targetReaders 空のとき同ペルソナは選択不可にする。
  const [genre, setGenre] = useState<string | null>(null);
  const [targetReaders, setTargetReaders] = useState<string | null>(null);
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();
  const annotationsByScene = useAnnotationStore((s) => s.annotationsByScene);
  const sceneAnnotations = annotationsByScene.get(sceneId) ?? [];
  const threads = groupPseudoThreads(sceneAnnotations);
  const panelActive = useKouetsuStore((s) => s.panelActive);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const reload = useCallback(async () => {
    const projectId = useTreeStore.getState().projectId;
    const resp = await listAnnotationsForScene({ projectId, sceneId });
    setAnnotations(sceneId, resp.annotations);
    const editor = useEditorStore.getState().editor;
    if (editor) applyAnnotationsToEditor(editor, resp.annotations);
  }, [sceneId, setAnnotations]);

  // 初回 / シーン切替時に読み込む。KouetsuPanel が keepalive で hidden の間は
  // bail する: reload の listAnnotations + setAnnotations + applyAnnotationsToEditor
  // は EditorPane のシーンロード (annotations を editor/store に適用) と冗長で、
  // hidden 中は EditorPane が editor を最新に保つ。再アクティブ化時に panelActive
  // が deps 経由で false→true になり現在シーンで 1 回 catch up する。
  useEffect(() => {
    if (!panelActive) return;
    void reload();
  }, [reload, panelActive]);

  // genre / 想定読者プロフィールを取得 (ペルソナ brief 注入 + ターゲット読者層の
  // 選択可否判定)。パネル再アクティブ化時に取り直し、設定変更を拾う。
  useEffect(() => {
    if (!panelActive) return;
    let cancelled = false;
    void fetchProjectContext().then((ctx) => {
      if (cancelled) return;
      setGenre(ctx?.genre ?? null);
      setTargetReaders(ctx?.targetReaders ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [panelActive]);

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
    if (running) return;
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
    setRunning(true);
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

      await reload();
      setRunning(false);

      if (!outcome.ok) {
        toast.error(t("kouetsu.pseudoComment.generationFailed"), {
          description: outcome.error,
        });
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
      setRunning(false);
      toast.error(t("kouetsu.pseudoComment.launchFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [running, sceneId, persona, genre, targetReaders, reload, lang]);

  const disabled = running || analysisGate.presentation !== "enabled";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <select
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          className="rounded border border-border bg-background px-1.5 py-0.5 text-xs outline-none"
        >
          {personaDefs.map((d) => {
            const locked =
              Boolean(d.requiresTargetProfile) && !hasTargetProfile;
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
              analysisGate.tooltip ?? t("kouetsu.pseudoComment.runTooltip")
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
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Info size={18} />
            <span>{t("kouetsu.pseudoComment.empty")}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {threads.map((t) => (
              <PseudoCommentThread
                key={t.root.id}
                thread={t}
                onChanged={() => void reload()}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
