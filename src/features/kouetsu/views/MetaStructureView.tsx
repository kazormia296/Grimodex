import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, Loader2, Sparkles, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { useLensStore } from "@/features/post-effect/lensStore";
import { useIsPostEffectRunning } from "@/features/post-effect/runStore";
import {
  buildMultiPayload,
  getSceneIdsForScope,
} from "@/features/post-effect/consistencyPayloadBuilder";
import {
  buildMetaStructurePayload,
  META_STRUCTURE_PROMPT_VERSION,
} from "@/features/post-effect/metaStructurePayloadBuilder";
import {
  flushPendingSceneSaves,
  runPostEffect,
  runPostEffectMulti,
} from "@/features/post-effect/api";
import { getPromptCatalog } from "@/prompts/index";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";
import {
  appendKouetsuGuidance,
  appendStoryContextGuidance,
} from "@/features/post-effect/customInstruction";
import { selectStoryContext } from "@/features/post-effect/storyContext";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { TensionCurve } from "@/features/post-effect/TensionCurve";
import { CausalityMapButton } from "@/features/map/CausalityMapButton";
import {
  buildTensionSeries,
  detectSaggyRuns,
} from "@/features/post-effect/tensionSeries";
import { postEffectErrorToast } from "@/features/post-effect/errorToast";
import type {
  PostEffectSeverity,
  SceneLensRecord,
} from "@/features/post-effect/types";

const SEVERITY_ICON: Record<PostEffectSeverity, React.ReactNode> = {
  error: <XCircle size={13} className="shrink-0 text-destructive" />,
  warning: <AlertTriangle size={13} className="shrink-0 text-yellow-500" />,
  suggestion: <Info size={13} className="shrink-0 text-blue-400" />,
  info: <Info size={13} className="shrink-0 text-muted-foreground" />,
};

const LENS_LABEL_KEY: Record<string, string> = {
  plot_structure: "kouetsu.lens.structure",
  pacing: "kouetsu.lens.pacing",
  character_arc: "kouetsu.lens.characterArc",
  pov: "kouetsu.lens.pov",
};

function LensRow({ lens }: { lens: SceneLensRecord }) {
  const { t } = useTranslation();
  const labelKey = LENS_LABEL_KEY[lens.lensType];
  return (
    <div className="flex items-start gap-1.5 rounded border border-border px-2 py-1.5 text-xs">
      {SEVERITY_ICON[lens.severity]}
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-[10px] font-medium text-muted-foreground">
          {labelKey ? t(labelKey) : lens.lensType}
        </span>
        <p className="leading-snug">{lens.finding}</p>
      </div>
    </div>
  );
}

interface Props {
  scope: "current" | "project";
  sceneId?: string;
}

export function MetaStructureView({ scope, sceneId }: Props) {
  const { t } = useTranslation();
  // 起動準備（payload 構築〜invoke）中のみのローカル状態。実行中かどうかは
  // runStore から導出する（ローカル useState だとタブ移動＝unmount で消え、
  // 実行中なのにボタンが通常表示へ戻る）。
  const [launching, setLaunching] = useState(false);
  // hook は短絡評価の右辺に置けないため、必ず無条件で呼ぶ。
  const sceneRunning = useIsPostEffectRunning(
    "meta_structure",
    "scene",
    sceneId,
  );
  const projectRunning = useIsPostEffectRunning("meta_structure", "project");
  const storeRunning = sceneRunning || projectRunning;
  const running = launching || storeRunning;
  const analysisGate = useAiGate("analysis");
  const projectId = useTreeStore((s) => s.projectId);
  const scenes = useTreeStore((s) => s.scenes);
  const nodes = useTreeStore((s) => s.nodes);
  const bySceneId = useLensStore((s) => s.bySceneId);
  const loadLens = useLensStore((s) => s.load);

  const tensionSeries = useMemo(
    () => buildTensionSeries(nodes, bySceneId),
    [nodes, bySceneId],
  );
  const saggy = useMemo(() => detectSaggyRuns(tensionSeries), [tensionSeries]);
  const hasTension = tensionSeries.some((p) => p.tension !== null);

  const sceneTitle = (id: string) =>
    scenes.find((s) => s.id === id)?.title ?? id;

  useEffect(() => {
    if (!useAiSettingsStore.getState().settings) {
      void useAiSettingsStore.getState().loadSettings();
    }
  }, []);

  useEffect(() => {
    if (projectId) void loadLens(projectId);
  }, [projectId, loadLens]);

  const runScene = useCallback(async () => {
    if (running || !sceneId) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const lang = getCurrentProjectLanguage();
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    const storyContext = selectStoryContext(
      useTreeStore.getState().nodes,
      sceneId,
    );
    setLaunching(true);
    try {
      await flushPendingSceneSaves(sceneId);
      const payload = await buildMetaStructurePayload(
        sceneId,
        model,
        customKouetsu,
        storyContext,
      );
      const outcome = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          runPostEffect(
            {
              project_id: projectId,
              effect_type: "meta_structure",
              scope_type: "scene",
              scope_target_id: sceneId,
              model,
              prompt_version: META_STRUCTURE_PROMPT_VERSION,
              input_hash: payload.inputHash,
              codex_payload_json: "[]",
              scene_text: payload.sceneText,
              system_prompt: appendStoryContextGuidance(
                appendKouetsuGuidance(
                  getPromptCatalog(lang).postEffect.metaStructureSystem,
                  customKouetsu,
                ),
                storyContext,
              ),
            },
            {
              onDone: () => resolve({ ok: true }),
              onError: (e) => resolve({ ok: false, error: e.error }),
            },
          ).catch((err) => resolve({ ok: false, error: String(err) }));
        },
      );
      await loadLens(projectId);
      setLaunching(false);
      if (!outcome.ok) {
        postEffectErrorToast(
          t("kouetsu.metaStructure.reviewFailed"),
          outcome.error,
        );
      }
    } catch (e) {
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.metaStructure.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [running, sceneId, projectId, loadLens, t]);

  const runProject = useCallback(async () => {
    if (running) return;
    if (blockIfPolicyOff("analysis")) return;
    if (blockIfUnlicensed()) return;
    const { nodes } = useTreeStore.getState();
    if (getSceneIdsForScope(nodes, "project", null).length === 0) return;
    const lang = getCurrentProjectLanguage();
    const model =
      useAiSettingsStore.getState().settings?.model ?? "gpt-4o-mini";
    const customKouetsu = useSettingsStore
      .getState()
      .get("aiPrompt.custom.kouetsu", "");
    setLaunching(true);
    try {
      await flushPendingSceneSaves();
      const payload = await buildMultiPayload(
        projectId,
        "project",
        null,
        model,
        "meta_structure",
        customKouetsu,
      );
      if (payload.scenes.length === 0) {
        setLaunching(false);
        return;
      }
      const outcome = await new Promise<{ ok: boolean; error?: string }>(
        (resolve) => {
          runPostEffectMulti(
            {
              project_id: projectId,
              effect_type: "meta_structure",
              scope_type: "project",
              scope_target_id: null,
              model,
              prompt_version: META_STRUCTURE_PROMPT_VERSION,
              input_hash: payload.inputHash,
              scenes: payload.scenes,
              system_prompt: appendKouetsuGuidance(
                getPromptCatalog(lang).postEffect.metaStructureSystem,
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
      await loadLens(projectId);
      setLaunching(false);
      if (!outcome.ok) {
        postEffectErrorToast(
          t("kouetsu.metaStructure.projectReviewFailed"),
          outcome.error,
        );
      }
    } catch (e) {
      setLaunching(false);
      postEffectErrorToast(
        t("kouetsu.metaStructure.launchFailed"),
        e instanceof Error ? e.message : String(e),
      );
    }
  }, [running, projectId, loadLens, t]);

  const projectGroups = useMemo(() => {
    if (scope !== "project") return [];
    return [...bySceneId.entries()]
      .map(([sid, lenses]) => ({
        sceneId: sid,
        label: sceneTitle(sid),
        lenses,
      }))
      .filter((g) => g.lenses.length > 0);
    // sceneTitle depends on scenes
  }, [bySceneId, scope, scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentLenses = sceneId ? (bySceneId.get(sceneId) ?? []) : [];
  const disabled = running || analysisGate.presentation !== "enabled";

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">
          {scope === "project"
            ? t("kouetsu.metaStructure.projectScope")
            : t("kouetsu.metaStructure.currentScope")}
        </span>
        {/* analysis がポリシーで OFF のときは実行ボタンを隠す（パネルは残す）。 */}
        {analysisGate.presentation !== "hidden" && (
          <button
            type="button"
            disabled={disabled || (scope === "current" && !sceneId)}
            onClick={() =>
              void (scope === "project" ? runProject() : runScene())
            }
            title={
              analysisGate.tooltip ?? t("kouetsu.metaStructure.runTooltip")
            }
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
            <span>{t("kouetsu.metaStructure.diagnosisButton")}</span>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {scope === "project" ? (
          <div className="flex flex-col gap-3">
            {hasTension && (
              <TensionCurve
                series={tensionSeries}
                saggy={saggy}
                onSelectScene={(id) =>
                  useTreeStore.getState().setActiveScene(id)
                }
              />
            )}
            <CausalityMapButton projectId={projectId} />
            {projectGroups.length === 0 ? (
              <EmptyState />
            ) : (
              projectGroups.map((g) => (
                <div key={g.sceneId} className="flex flex-col gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      useTreeStore.getState().setActiveScene(g.sceneId)
                    }
                    className="self-start truncate text-[11px] font-medium text-muted-foreground hover:text-foreground"
                  >
                    {g.label}
                  </button>
                  {g.lenses.map((l) => (
                    <LensRow key={l.id} lens={l} />
                  ))}
                </div>
              ))
            )}
          </div>
        ) : currentLenses.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-1.5">
            {currentLenses.map((l) => (
              <LensRow key={l.id} lens={l} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
      <Info size={18} />
      <span>{t("kouetsu.metaStructure.empty")}</span>
    </div>
  );
}
