import { useCallback, useEffect, useMemo, useState } from "react";
import { Info, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import {
  buildMultiPayload,
  getSceneIdsForScope,
} from "@/features/post-effect/consistencyPayloadBuilder";
import { REVIEW_PROMPT_VERSION } from "@/features/post-effect/reviewPayloadBuilder";
import {
  flushPendingSceneSaves,
  listAnnotationsForProject,
  runPostEffectMulti,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { appendKouetsuGuidance } from "@/features/post-effect/customInstruction";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { AnnotationItem } from "@/features/post-effect/PostEffectAnnotationPanel";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

export function ProjectReviewView() {
  const [annotations, setAnnotations] = useState<PostEffectAnnotation[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const analysisGate = useAiGate("analysis");

  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);

  const sceneTitle = (sceneId: string) =>
    scenes.find((s) => s.id === sceneId)?.title ?? sceneId;

  const reload = useCallback(() => {
    if (!projectId) return;
    setLoading(true);
    listAnnotationsForProject({ projectId, status: "open" })
      .then((resp) =>
        setAnnotations(resp.annotations.filter((a) => a.category === "review")),
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

  const runAll = useCallback(async () => {
    if (runningAll) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const { nodes } = useTreeStore.getState();
    if (getSceneIdsForScope(nodes, "project", null).length === 0) return;
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    setRunningAll(true);
    try {
      await flushPendingSceneSaves();
      const payload = await buildMultiPayload(
        projectId,
        "project",
        null,
        model,
        "review",
        customKouetsu,
      );
      if (payload.scenes.length === 0) {
        setRunningAll(false);
        return;
      }
      const outcome = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          runPostEffectMulti(
            {
              project_id: projectId,
              effect_type: "review",
              scope_type: "project",
              scope_target_id: null,
              model,
              prompt_version: REVIEW_PROMPT_VERSION,
              input_hash: payload.inputHash,
              scenes: payload.scenes,
              system_prompt: appendKouetsuGuidance(
                getPromptCatalog("ja").postEffect.reviewSystem,
                customKouetsu,
              ),
            },
            {
              onDone: () => resolve({ ok: true }),
              onError: (e) => resolve({ ok: false, error: e.error }),
            },
          ).catch((err) => resolve({ ok: false, error: String(err) }));
        },
      );
      reload();
      setRunningAll(false);
      if (!outcome.ok) {
        toast.error("全シーン批評に失敗しました", {
          description: outcome.error,
        });
      }
    } catch (e) {
      console.error("review multi launch error", e);
      setRunningAll(false);
      toast.error("全シーン批評を起動できませんでした", {
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [runningAll, projectId, reload]);

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
    // sceneTitle depends on `scenes`
  }, [annotations, scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">全シーン批評</span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={runningAll || analysisGate.presentation !== "enabled"}
            onClick={() => void runAll()}
            title={analysisGate.tooltip ?? "全シーンの批評を実行"}
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
            <span>AIレビュー</span>
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={16} className="animate-spin text-muted-foreground" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
          <Info size={16} />
          <span>批評はまだありません</span>
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
                  <AnnotationItem key={ann.id} ann={ann} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
