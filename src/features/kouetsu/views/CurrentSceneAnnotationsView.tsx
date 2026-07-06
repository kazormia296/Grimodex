import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import { useEditorStore } from "@/features/editor/editorStore";
import { listAnnotationsForScene } from "@/features/post-effect/api";
import { runConsistencyCheck } from "@/features/kouetsu/runners";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import { PostEffectAnnotationPanel } from "@/features/post-effect/PostEffectAnnotationPanel";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

interface Props {
  sceneId: string;
}

function getDetectedByModel(ann: PostEffectAnnotation): string | undefined {
  let meta: Record<string, unknown> | undefined;
  try {
    meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown> | undefined);
  } catch {
    return undefined;
  }
  if (!meta) return undefined;
  const ref = (meta.codex_ref as Record<string, unknown> | undefined) ?? {};
  return (
    (ref.detected_by_model as string | undefined) ??
    (meta.detected_by_model as string | undefined)
  );
}

function countOpenByOtherModel(
  annotations: PostEffectAnnotation[],
  currentModels: readonly string[],
): { total: number; byModel: Map<string, number> } {
  // この run で実際に使ったモデル集合。機能別モデルにより consistency(review ロール)と
  // intra(既定)は別モデルになり得るため、いずれかに一致する注釈は「今回のモデル」と
  // みなして除外する（さもないと別モデル警告が誤発火する）。
  const current = new Set(currentModels.filter(Boolean));
  const byModel = new Map<string, number>();
  let total = 0;
  for (const ann of annotations) {
    if (ann.status !== "open") continue;
    const m = getDetectedByModel(ann);
    if (!m || current.has(m)) continue;
    byModel.set(m, (byModel.get(m) ?? 0) + 1);
    total += 1;
  }
  return { total, byModel };
}

export function CurrentSceneAnnotationsView({ sceneId }: Props) {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const consistencyRunning = useIsPostEffectRunning(
    "consistency",
    "scene",
    sceneId,
  );
  const intraRunning = useIsPostEffectRunning(
    "intra_scene_consistency",
    "scene",
    sceneId,
  );
  const storeRunning = consistencyRunning || intraRunning;
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
    setLaunching(true);
    try {
      // ガード → role override 解決 → flush → payload build → 2 run 並行起動は
      // runner に委譲する（全体チェックと同一経路 = input_hash / キャッシュキーが
      // 分裂しない）。片側の build 失敗は runner が ok:false へ畳む。
      const { codex, intra, models } = await runConsistencyCheck({
        type: "scene",
        sceneId,
      });
      // ガード拒否は無反応（ガードが toast 済み。両側同時に blocked になる）。
      if ("blocked" in codex || "blocked" in intra) {
        setLaunching(false);
        return;
      }

      const projectId = useTreeStore.getState().projectId;
      const resp = await listAnnotationsForScene({ projectId, sceneId });
      setAnnotations(sceneId, resp.annotations);
      const editor = useEditorStore.getState().editor;
      if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      setLaunching(false);

      const labelOf = (e: "consistency" | "intra") =>
        e === "consistency"
          ? t("kouetsu.consistency.codexLabel")
          : t("kouetsu.consistency.intraLabel");
      const results = [
        { effect: "consistency" as const, outcome: codex },
        { effect: "intra" as const, outcome: intra },
      ];
      const errors = results.flatMap((r) =>
        r.outcome.ok ? [] : [{ effect: r.effect, error: r.outcome.error }],
      );
      const oks = results.flatMap((r) =>
        r.outcome.ok && "count" in r.outcome ? [r.outcome] : [],
      );

      if (errors.length === results.length) {
        toast.error(t("integrity.checkError"), {
          description: errors
            .map((r) => `${labelOf(r.effect)}: ${r.error}`)
            .join(" / "),
        });
        return;
      }
      if (errors.length > 0) {
        postEffectErrorToast(
          t("kouetsu.consistency.partialError", {
            effect: labelOf(errors[0]!.effect),
          }),
          errors[0]!.error,
        );
      } else {
        const allCache = oks.every((o) => o.fromCache);
        const totalCount = oks.reduce((sum, o) => sum + o.count, 0);
        if (allCache) {
          toast.info(t("kouetsu.consistency.fromCache"), {
            description: t("kouetsu.cache.notSent"),
          });
        } else if (totalCount === 0) {
          toast.success(t("kouetsu.consistency.noIssues"));
        }
      }

      // 「今回のモデル」集合は runner が実際に使ったものを使う（別導出だと
      // 役割別モデルの変更時に警告だけがズレる）。
      if (models) {
        const otherModelCount = countOpenByOtherModel(resp.annotations, [
          models.codex,
          models.intra,
        ]);
        if (otherModelCount.total > 0) {
          const sample = [...otherModelCount.byModel.entries()]
            .map(([m, n]) =>
              t("kouetsu.consistency.modelCount", { model: m, count: n }),
            )
            .join(", ");
          toast.info(
            t("kouetsu.consistency.otherModelWarning", {
              count: otherModelCount.total,
            }),
            { description: sample },
          );
        }
      }
    } catch (e) {
      console.error("post-effect launch error", e);
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.consistency.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [running, sceneId, setAnnotations, t]);

  const disabled = running || analysisGate.presentation !== "enabled";
  const triggerTitle =
    analysisGate.tooltip ?? t("kouetsu.consistency.runCurrentScene");

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.currentScene.consistency")}
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
        <PostEffectAnnotationPanel sceneId={sceneId} />
      </div>
    </div>
  );
}
