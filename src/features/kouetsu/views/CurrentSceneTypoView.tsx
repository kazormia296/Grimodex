import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Sparkles,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useEditorStore } from "@/features/editor/editorStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import {
  buildTypoPayload,
  TYPO_PROMPT_VERSION,
} from "@/features/post-effect/typoPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForScene,
  runPostEffect,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { closeAnnotation } from "@/features/post-effect/closeAnnotation";
import { applyTypoFixAndResolve } from "@/features/post-effect/typoFix";
import { parseAnnotationMeta } from "@/features/post-effect/annotationMeta";
import {
  ConfidenceBadge,
  ExpandedDetails,
  TypoChip,
  TypoContrastRow,
} from "@/features/post-effect/AnnotationDetails";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";
import type {
  PostEffectAnnotation,
  PostEffectSeverity,
} from "@/features/post-effect/types";

// Stable empty fallback — Zustand のセレクタが render ごとに新規 `[]` を返すと
// useSyncExternalStore が「snapshot が変わった」と判定して無限ループする。
const EMPTY_ANNOTATIONS: PostEffectAnnotation[] = [];

const SEVERITY_ICONS: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="text-destructive shrink-0" />,
  warning: <AlertTriangle size={13} className="text-yellow-500 shrink-0" />,
  suggestion: <Info size={13} className="text-blue-400 shrink-0" />,
  info: <Info size={13} className="text-muted-foreground shrink-0" />,
};

interface Props {
  sceneId: string;
}

export function CurrentSceneTypoView({ sceneId }: Props) {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const storeRunning = useIsPostEffectRunning(
    "typo_detection",
    "scene",
    sceneId,
  );
  const running = launching || storeRunning;
  const analysisGate = useAiGate("analysis");
  const { setAnnotations } = useAnnotationStore();

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const run = useCallback(async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const projectId = useTreeStore.getState().projectId;
    const lang = getCurrentProjectLanguage();
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    setLaunching(true);
    try {
      await flushPendingSceneSaves(sceneId);
      const payload = await buildTypoPayload(sceneId, model, customKouetsu);
      const done = await new Promise<{
        ok: boolean;
        from_cache?: boolean;
        count?: number;
        error?: string;
      }>((resolve) => {
        runPostEffect(
          {
            project_id: projectId,
            effect_type: "typo_detection",
            scope_type: "scene",
            scope_target_id: sceneId,
            model,
            prompt_version: TYPO_PROMPT_VERSION,
            input_hash: payload.inputHash,
            codex_payload_json: "[]",
            scene_text: payload.sceneText,
            system_prompt: appendKouetsuGuidance(
              getPromptCatalog(lang).postEffect.typoSystem,
              customKouetsu,
            ),
          },
          {
            onDone: (e) =>
              resolve({
                ok: true,
                from_cache: e.from_cache,
                count: e.annotation_count,
              }),
            onError: (e) => resolve({ ok: false, error: e.error }),
          },
        ).catch((err) => resolve({ ok: false, error: String(err) }));
      });

      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      setLaunching(false);

      if (!done.ok) {
        postEffectErrorToast(t("kouetsu.typo.checkFailed"), done.error);
        return;
      }
      if (done.from_cache) {
        toast.info(t("kouetsu.consistency.fromCache"), {
          description: t("kouetsu.cache.notSent"),
        });
      } else if ((done.count ?? 0) === 0) {
        toast.success(t("kouetsu.typo.noIssues"));
      }
    } catch (e) {
      console.error("typo run error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.typo.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [running, sceneId, setAnnotations, t]);

  const disabled = running || analysisGate.presentation !== "enabled";
  const triggerTitle = analysisGate.tooltip ?? t("kouetsu.typo.currentTooltip");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.currentScene.typo")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={disabled}
            title={triggerTitle}
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
            <span>{t("kouetsu.aiCheck")}</span>
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AiTypoList sceneId={sceneId} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI typo annotations
// ---------------------------------------------------------------------------

function AiTypoList({ sceneId }: { sceneId: string }) {
  const { t } = useTranslation();
  const annotations = useAnnotationStore(
    (s) => s.annotationsByScene.get(sceneId) ?? EMPTY_ANNOTATIONS,
  );
  const typoAnns = useMemo(
    () => annotations.filter((a) => a.category === "typo_anchor"),
    [annotations],
  );
  const open = typoAnns.filter((a) => a.status === "open");
  const done = typoAnns.filter(
    (a) => a.status === "resolved" || a.status === "dismissed",
  );

  return (
    <section className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-[11px] font-medium text-muted-foreground">
        <span>{t("kouetsu.typo.aiDetection")}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
          {open.length}
        </span>
      </div>
      {typoAnns.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("kouetsu.typo.aiEmpty")}
        </p>
      ) : (
        <div className="flex flex-col gap-1 p-2">
          {open.map((a) => (
            <TypoAnnotationRow key={a.id} ann={a} />
          ))}
          {done.length > 0 && (
            <>
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                {t("kouetsu.typo.resolvedIgnored")}
              </p>
              {done.map((a) => (
                <TypoAnnotationRow key={a.id} ann={a} />
              ))}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TypoAnnotationRow({ ann }: { ann: PostEffectAnnotation }) {
  const { t } = useTranslation();
  const { focusedAnnotationId, setFocusedAnnotationId } = useAnnotationStore();
  const editor = useEditorStore((s) => s.editor);
  const focused = focusedAnnotationId === ann.id;
  const parsed = parseAnnotationMeta(ann);
  const currentModel = useAiSettingsStore((s) => s.settings?.model);
  const severity = (ann.severity ?? "info") as PostEffectSeverity;
  const isDone = ann.status === "dismissed" || ann.status === "resolved";
  const canFix =
    !!parsed.typo?.suggestion &&
    !!parsed.foundText &&
    !!editor &&
    ann.status === "open";

  async function dismiss() {
    await closeAnnotation(ann, "dismissed", editor);
  }
  async function resolve() {
    await closeAnnotation(ann, "resolved", editor);
  }
  async function fix() {
    const result = await applyTypoFixAndResolve(editor, ann);
    if (!result.applied) {
      toast.error(t("kouetsu.typo.replacementFailed"), {
        description: t("kouetsu.typo.replacementFailedDesc"),
      });
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setFocusedAnnotationId(focused ? null : ann.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ")
          setFocusedAnnotationId(focused ? null : ann.id);
      }}
      className={cn(
        "group flex flex-col gap-1 rounded border px-2 py-1.5 text-xs cursor-pointer select-none transition-colors",
        focused
          ? "border-primary/60 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:bg-accent/30",
        isDone && "opacity-50",
      )}
    >
      <div className="flex items-start gap-1.5">
        {SEVERITY_ICONS[severity]}
        <div className="flex flex-1 flex-wrap items-center gap-1.5">
          {parsed.typo && <TypoChip category={parsed.typo.category} />}
          {parsed.confidence && <ConfidenceBadge level={parsed.confidence} />}
        </div>
        {!isDone && (
          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {canFix && (
              <button
                aria-label={t("kouetsu.typo.quickFixAria")}
                title={t("kouetsu.typo.replaceWith", {
                  suggestion: parsed.typo!.suggestion,
                })}
                onClick={(e) => {
                  e.stopPropagation();
                  void fix();
                }}
                className="rounded p-0.5 text-blue-600 hover:bg-blue-500/20"
              >
                <Wrench size={13} />
              </button>
            )}
            <button
              aria-label={t("kouetsu.typo.resolved")}
              title={t("kouetsu.typo.resolved")}
              onClick={(e) => {
                e.stopPropagation();
                resolve();
              }}
              className="rounded p-0.5 text-green-600 hover:bg-green-500/20"
            >
              <CheckCircle2 size={13} />
            </button>
            <button
              aria-label={t("kouetsu.typo.dismiss")}
              title={t("kouetsu.typo.dismiss")}
              onClick={(e) => {
                e.stopPropagation();
                dismiss();
              }}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
      {parsed.typo && (
        <TypoContrastRow
          found={parsed.foundText}
          suggestion={parsed.typo.suggestion}
        />
      )}
      {ann.textSnapshot && (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-2 text-muted-foreground line-clamp-2">
          {ann.textSnapshot}
        </blockquote>
      )}
      {focused && (
        <ExpandedDetails parsed={parsed} currentModel={currentModel} />
      )}
    </div>
  );
}
