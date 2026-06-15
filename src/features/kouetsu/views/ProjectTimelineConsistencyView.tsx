import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { useEditorStore } from "@/features/editor/editorStore";
import {
  buildTimelinePayload,
  TIMELINE_CONSISTENCY_PROMPT_VERSION,
} from "@/features/post-effect/timelinePayloadBuilder";
import {
  detectTimelineHygiene,
  type TimelineHygieneFinding,
} from "@/features/post-effect/timelineHygiene";
import {
  flushPendingSceneSaves,
  listAnnotationsForProject,
  listAnnotationsForScene,
  runPostEffectMulti,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import {
  appendKouetsuGuidance,
  appendTimelineGuidance,
} from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

/**
 * 物語内時系列の整合性 (timeline_consistency)。project スコープの multi run で
 * 各シーン本文を確立済タイムライン要約に照らし、矛盾を指摘する。あわせて LLM 不要の
 * 決定論データ衛生 (重複/不正キー) を live 表示する (ハイブリッドの検証可能な半分)。
 */
export function ProjectTimelineConsistencyView() {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const analysisGate = useAiGate("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const nodes = useTreeStore((s) => s.nodes);
  const { setAnnotations: storeSetAnnotations } = useAnnotationStore();

  const titleById = useMemo(
    () => new Map(nodes.map((n) => [n.id, n.title] as const)),
    [nodes],
  );
  const sceneTitle = (sceneId: string) => titleById.get(sceneId) ?? sceneId;

  // 決定論データ衛生 (live 再計算・LLM 不要)。
  const hygiene = useMemo<TimelineHygieneFinding[]>(
    () =>
      detectTimelineHygiene(
        nodes
          .filter((n) => n.nodeType === "scene")
          .map((n) => ({
            id: n.id,
            title: n.title,
            storyTimeOrder: n.storyTimeOrder,
          })),
      ),
    [nodes],
  );

  const reload = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(
          resp.annotations.filter((a) => a.category === "timeline_anchor"),
        ),
      )
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  const afterRunAll = useCallback(
    async (activeSceneId: string | null) => {
      if (activeSceneId) {
        const resp = await listAnnotationsForScene({
          projectId,
          sceneId: activeSceneId,
        });
        storeSetAnnotations(activeSceneId, resp.annotations);
        const editor = useEditorStore.getState().editor;
        if (editor) applyAnnotationsToEditor(editor, resp.annotations);
      }
      const fresh = await listAnnotationsForProject({
        projectId,
        status: "open",
      });
      setAnnotations(
        fresh.annotations.filter((a) => a.category === "timeline_anchor"),
      );
    },
    [projectId, storeSetAnnotations],
  );

  const runAll = useCallback(async () => {
    if (runningAll) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const lang = getCurrentProjectLanguage();
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    const activeSceneId = useTreeStore.getState().activeSceneId;
    setRunningAll(true);
    try {
      await flushPendingSceneSaves();
      const payload = await buildTimelinePayload(
        "project",
        null,
        model,
        customKouetsu,
      );
      if (payload.scenes.length === 0) {
        setRunningAll(false);
        toast.info(t("kouetsu.projectTimeline.noScenesPlaced"), {
          description: t("kouetsu.projectTimeline.placeScenesHint"),
        });
        return;
      }
      const outcome = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          runPostEffectMulti(
            {
              project_id: projectId,
              effect_type: "timeline_consistency",
              scope_type: "project",
              scope_target_id: null,
              model,
              prompt_version: TIMELINE_CONSISTENCY_PROMPT_VERSION,
              input_hash: payload.inputHash,
              scenes: payload.scenes,
              system_prompt: appendTimelineGuidance(
                appendKouetsuGuidance(
                  getPromptCatalog(lang).postEffect.timelineConsistencySystem,
                  customKouetsu,
                ),
                payload.timelineContext,
              ),
            },
            {
              onDone: () => resolve({ ok: true }),
              onError: (e) => resolve({ ok: false, error: e.error }),
            },
          ).catch((err) => resolve({ ok: false, error: String(err) }));
        },
      );
      await afterRunAll(activeSceneId);
      setRunningAll(false);
      if (!outcome.ok) {
        toast.error(t("kouetsu.projectTimeline.checkFailed"), {
          description: outcome.error,
        });
      }
    } catch (e) {
      console.error("timeline multi launch error", e);
      setRunningAll(false);
      toast.error(t("kouetsu.projectTimeline.launchFailed"), {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [runningAll, projectId, afterRunAll]);

  const groups = useMemo(() => {
    const acc = new Map<
      string,
      { sceneId: string; label: string; items: PostEffectAnnotation[] }
    >();
    for (const ann of annotations) {
      if (!ann.sceneId) continue;
      const g = acc.get(ann.sceneId) ?? {
        sceneId: ann.sceneId,
        label: sceneTitle(ann.sceneId),
        items: [],
      };
      g.items.push(ann);
      acc.set(ann.sceneId, g);
    }
    return [...acc.values()];
  }, [annotations, titleById]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {t("kouetsu.projectTimeline.header")}
        </span>
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runAll()}
            title={
              analysisGate.tooltip ?? t("kouetsu.projectTimeline.checkTooltip")
            }
            className={cn(
              "flex items-center gap-1 rounded px-2 py-0.5 text-xs",
              "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {runningAll ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            <span>{t("kouetsu.projectTimeline.checkButton")}</span>
          </button>
        )}
      </div>

      {hygiene.length > 0 && (
        <div className="flex flex-col border-b border-border">
          <div className="flex items-center gap-1.5 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle size={12} />
            <span>{t("kouetsu.projectTimeline.dataInconsistency")}</span>
            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] leading-none">
              {hygiene.length}
            </span>
          </div>
          <ul className="flex flex-col">
            {hygiene.map((h) => (
              <li key={`${h.kind}:${h.sceneId}`}>
                <button
                  type="button"
                  onClick={() =>
                    useTreeStore.getState().setActiveScene(h.sceneId)
                  }
                  className="flex w-full items-center gap-1.5 px-3 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <span className="truncate">{sceneTitle(h.sceneId)}</span>
                  <span className="ml-auto shrink-0 text-[10px]">
                    {h.kind === "duplicate_order"
                      ? t("kouetsu.projectTimeline.duplicateKey")
                      : t("kouetsu.projectTimeline.invalidKey")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>{t("kouetsu.projectTimeline.empty")}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-0">
          {groups.map((g) => (
            <div key={g.sceneId} className="flex flex-col">
              <div
                role="button"
                tabIndex={0}
                onClick={() =>
                  useTreeStore.getState().setActiveScene(g.sceneId)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    useTreeStore.getState().setActiveScene(g.sceneId);
                }}
                className="sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 border-b border-border bg-muted/30 px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/50"
              >
                <span className="truncate">{g.label}</span>
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none">
                  {g.items.length}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2">
                {g.items.map((ann) => (
                  <AnnotationItem
                    key={ann.id}
                    ann={ann}
                    onStatusChange={(annotationId, status) => {
                      if (status === "open") return;
                      setAnnotations((prev) =>
                        prev.filter((a) => a.id !== annotationId),
                      );
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
