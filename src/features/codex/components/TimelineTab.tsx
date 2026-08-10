import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Clock,
  FileText,
  MapPin,
  Pencil,
  Trash2,
  Plus,
  Settings2,
  Eye,
  EyeOff,
} from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import {
  computePhaseExposureBreakdown,
  type PhaseResolutionMode,
  type SceneTimeIndex,
} from "../phaseResolver";
import { useTreeStore } from "@/features/tree/treeStore";
import { PhaseDialog } from "./PhaseDialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TimelineItemSkeletonList } from "@/components/ui/skeleton-patterns";
import { resolveApplicablePhases } from "../context/resolveApplicablePhases";

interface TimelineTabProps {
  entry: CodexEntry;
}

const EMPTY_PHASES: CodexEntryPhase[] = [];

export function resolvePhaseContentSeed(input: {
  phases: CodexEntryPhase[];
  index: SceneTimeIndex;
  mode: PhaseResolutionMode;
  anchorNodeId: string;
  baseContent: string;
  targetPhaseId?: string;
}): string {
  const targetId = input.targetPhaseId ?? "__new_phase_content_seed__";
  const existingTarget = input.phases.find(
    (phase) => phase.id === input.targetPhaseId,
  );
  const phases = existingTarget
    ? input.phases.map((phase) =>
        phase.id === existingTarget.id
          ? { ...phase, anchorNodeId: input.anchorNodeId }
          : phase,
      )
    : [
        ...input.phases,
        {
          id: targetId,
          entryId: input.phases[0]?.entryId ?? "__new_entry__",
          label: "",
          anchorNodeId: input.anchorNodeId,
          summaryOverride: null,
          contentOverride: null,
          contextModeOverride: null,
          version: 0,
          // New siblings are appended by the current createdAt tie-break. A
          // far-future synthetic timestamp models that insertion explicitly.
          createdAt: "9999-12-31T23:59:59.999Z",
          updatedAt: "9999-12-31T23:59:59.999Z",
        },
      ];
  const resolution = resolveApplicablePhases({
    phases,
    index: input.index,
    mode: input.mode,
    anchor: { kind: "phase", phaseId: targetId },
  });
  for (let i = resolution.applicablePhases.length - 1; i >= 0; i--) {
    const content = resolution.applicablePhases[i].contentOverride;
    if (content !== null) return content;
  }
  return input.baseContent;
}

export function TimelineTab({ entry }: TimelineTabProps) {
  const { t } = useTranslation();
  const rawPhases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const phases = rawPhases ?? EMPTY_PHASES;
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const sceneTimeIndex = usePhaseStore((s) => s.sceneTimeIndex);
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);
  const deletePhase = usePhaseStore((s) => s.deletePhase);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPhase, setEditingPhase] = useState<CodexEntryPhase | null>(
    null,
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    void loadPhasesForEntry(entry.id);
  }, [entry.id, loadPhasesForEntry]);

  const latestPhaseResolution = useMemo(
    () =>
      resolveApplicablePhases({
        phases,
        index: sceneTimeIndex,
        mode: resolutionMode,
        anchor: { kind: "latest" },
      }),
    [phases, sceneTimeIndex, resolutionMode],
  );

  const currentPhaseResolution = useMemo(
    () =>
      activeSceneId
        ? resolveApplicablePhases({
            phases,
            index: sceneTimeIndex,
            mode: resolutionMode,
            anchor: { kind: "scene", sceneId: activeSceneId },
          })
        : null,
    [activeSceneId, phases, sceneTimeIndex, resolutionMode],
  );

  const timelinePhaseResolution =
    currentPhaseResolution?.axisUsed != null
      ? currentPhaseResolution
      : latestPhaseResolution;
  const sortedPhases = timelinePhaseResolution.orderedPhases;

  // Resolve the seed only after the dialog has selected an anchor. A global
  // latest value would copy future Phase content into an earlier Phase.
  const resolveContentAtAnchor = useCallback(
    (anchorNodeId: string, targetPhaseId?: string): string =>
      resolvePhaseContentSeed({
        phases,
        index: sceneTimeIndex,
        mode: resolutionMode,
        anchorNodeId,
        baseContent: entry.content ?? "{}",
        targetPhaseId,
      }),
    [entry.content, phases, resolutionMode, sceneTimeIndex],
  );

  // アンカーなし（順序不明）のフェーズ
  const unsortedPhases = useMemo(() => {
    const skippedIds = new Set(timelinePhaseResolution.skippedPhaseIds);
    return phases.filter((phase) => skippedIds.has(phase.id));
  }, [phases, timelinePhaseResolution]);

  // 現在のアクティブフェーズID
  const activePhaseId = useMemo(() => {
    return currentPhaseResolution?.applicablePhases.at(-1)?.id ?? null;
  }, [currentPhaseResolution]);

  // 現在地マーカー: activeSceneId の order と phase アンカーを比較し、
  // ① 該当 scene が phase アンカー上なら既存 ◉ に任せて ▶ 行は出さない
  // ② アンカー間なら sortedPhases の差込位置 (insertBefore) を算出
  // ③ activeSceneId が未解決 / 未設定なら isMissingContext = true で pill を出す
  const currentMarker = useMemo(() => {
    if (!activeSceneId || currentPhaseResolution?.axisUsed == null) {
      return { missing: true as const };
    }
    const exactMatch = sortedPhases.some(
      (phase) => phase.anchorNodeId === activeSceneId,
    );
    if (exactMatch) return { missing: false as const, insertBefore: null };
    return {
      missing: false as const,
      insertBefore: currentPhaseResolution.applicablePhases.length,
    };
  }, [activeSceneId, currentPhaseResolution, sortedPhases]);

  const exposure = useMemo(
    () =>
      computePhaseExposureBreakdown({
        baseSummary: entry.summary,
        baseContextMode: entry.contextMode,
        phases: latestPhaseResolution.orderedPhases,
      }),
    [entry.summary, entry.contextMode, latestPhaseResolution],
  );

  const currentSceneTitle = activeSceneId
    ? (nodes.find((n) => n.id === activeSceneId)?.title ?? null)
    : null;

  const getSceneTitle = (nodeId: string | null): string => {
    if (!nodeId) return "─";
    return nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  };

  const handleEdit = (phase: CodexEntryPhase) => {
    setEditingPhase(phase);
    setDialogOpen(true);
  };

  const handleAdd = () => {
    setEditingPhase(null);
    setDialogOpen(true);
  };

  const handleClose = () => {
    setDialogOpen(false);
    setEditingPhase(null);
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDeleteId) return;
    await deletePhase(confirmDeleteId);
    setConfirmDeleteId(null);
  };

  const confirmPhase = phases.find((p) => p.id === confirmDeleteId);

  if (rawPhases === undefined) {
    return (
      <TimelineItemSkeletonList
        testId="timeline-tab-loading"
        className="px-2 py-4"
      />
    );
  }

  // フェーズ0件の空状態
  if (phases.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-[13px] font-medium text-foreground">
          {t("codex.timeline.noPhases")}
        </p>
        <p className="max-w-[240px] text-xs text-muted-foreground">
          {t("codex.timeline.noPhasesDesc")}
        </p>
        <button
          type="button"
          onClick={handleAdd}
          className="mt-1 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("codex.timeline.addPhase")}
        </button>

        {dialogOpen && (
          <PhaseDialog
            entryId={entry.id}
            phase={null}
            onClose={handleClose}
            resolveCurrentContent={resolveContentAtAnchor}
            existingDetailOverrideCount={0}
          />
        )}
      </div>
    );
  }

  const orderModeLabelKey =
    resolutionMode === "reading"
      ? "codex.timeline.orderModeReading"
      : resolutionMode === "story"
        ? "codex.timeline.orderModeStory"
        : "codex.timeline.orderModeAuto";
  const orderModeDescKey =
    resolutionMode === "reading"
      ? "codex.timeline.orderModeReadingDesc"
      : resolutionMode === "story"
        ? "codex.timeline.orderModeStoryDesc"
        : "codex.timeline.orderModeAutoDesc";

  const COST_WARN_THRESHOLD = 600;
  const exposureBadge =
    exposure.total > 0 ? (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <span
              data-testid="phase-exposure-ai"
              className="inline-flex items-center gap-1"
            >
              <Eye className="h-2.5 w-2.5" />
              {t("codex.timeline.exposureAiCount", {
                count: exposure.aiVisibleCount,
              })}
              {exposure.maxAiVisibleSummaryChars > 0 && (
                <span
                  className={
                    exposure.maxAiVisibleSummaryChars > COST_WARN_THRESHOLD
                      ? "text-destructive"
                      : ""
                  }
                >
                  {t("codex.timeline.exposureAiChars", {
                    chars: exposure.maxAiVisibleSummaryChars,
                  })}
                </span>
              )}
            </span>
            <span className="h-3 w-px bg-border" />
            <span
              data-testid="phase-exposure-wiki"
              className="inline-flex items-center gap-1"
            >
              <EyeOff className="h-2.5 w-2.5" />
              {t("codex.timeline.exposureWikiCount", {
                count: exposure.wikiOnlyCount,
              })}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 text-xs">
          <p className="font-semibold text-foreground">
            {t("codex.timeline.exposureTitle")}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {t("codex.timeline.exposureDesc")}
          </p>
          {exposure.maxAiVisibleSummaryChars > COST_WARN_THRESHOLD && (
            <p className="mt-2 text-[11px] leading-relaxed text-destructive">
              {t("codex.timeline.exposureCostWarning", {
                chars: exposure.maxAiVisibleSummaryChars,
              })}
            </p>
          )}
        </PopoverContent>
      </Popover>
    ) : null;

  const orderModeBadge = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Clock className="h-2.5 w-2.5" />
          {t(orderModeLabelKey)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 text-xs">
        <p className="font-semibold text-foreground">{t(orderModeLabelKey)}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {t(orderModeDescKey)}
        </p>
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("open-settings", {
                detail: { category: "project" },
              }),
            )
          }
          className="mt-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary hover:bg-accent"
        >
          <Settings2 className="h-3 w-3" />
          {t("codex.timeline.orderModeOpenSettings")}
        </button>
      </PopoverContent>
    </Popover>
  );

  const currentMarkerRow = currentSceneTitle ? (
    <div className="flex gap-2">
      <div className="flex w-4 justify-center">
        <MapPin className="mt-1 h-3 w-3 text-primary" />
      </div>
      <div className="flex flex-1 items-center gap-1 py-1">
        <div className="h-px flex-1 bg-primary/30" />
        <span className="shrink-0 text-[10px] font-medium text-primary">
          {t("codex.timeline.currentSceneHere", { title: currentSceneTitle })}
        </span>
        <div className="h-px flex-1 bg-primary/30" />
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-0">
      {/* Exposure breakdown + Order mode badge + Scene 文脈なし pill */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {exposureBadge}
        {orderModeBadge}
        {currentMarker.missing && (
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
            <MapPin className="h-2.5 w-2.5" />
            {t("codex.timeline.noSceneContext")}
          </span>
        )}
      </div>

      {/* Base state */}
      <div className="flex gap-2">
        <div className="flex flex-col items-center">
          <span className="mt-1 text-xs text-muted-foreground">●</span>
          <div className="mt-1 w-px flex-1 bg-border" />
        </div>
        <div className="pb-3 pt-0.5">
          <p className="text-xs font-semibold">
            {t("codex.timeline.baseState")}
          </p>
          {entry.summary && (
            <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
              {entry.summary}
            </p>
          )}
        </div>
      </div>

      {/* Sorted phases */}
      {sortedPhases.map((phase, i) => {
        const isActive = phase.id === activePhaseId;
        return (
          <Fragment key={phase.id}>
            {!currentMarker.missing &&
              currentMarker.insertBefore === i &&
              currentMarkerRow}
            {/* Scene separator */}
            <div className="flex items-center gap-2">
              <div className="flex w-4 justify-center">
                <div className="h-full w-px bg-border" />
              </div>
              <div className="flex flex-1 items-center gap-1 py-1">
                <div className="h-px flex-1 bg-border" />
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {getSceneTitle(phase.anchorNodeId)}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </div>

            {/* Phase node */}
            <div className="flex gap-2">
              <div className="flex flex-col items-center">
                <span
                  className={`mt-1 text-xs ${isActive ? "text-primary" : "text-muted-foreground"}`}
                >
                  {isActive ? "◉" : "●"}
                </span>
                <div className="mt-1 w-px flex-1 bg-border" />
              </div>
              <div className="flex-1 pb-3 pt-0.5">
                <div className="flex items-start justify-between gap-2">
                  <p
                    className={`text-xs font-semibold ${isActive ? "text-primary" : ""}`}
                  >
                    {phase.label}
                  </p>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => handleEdit(phase)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(phase.id)}
                      className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Diff view */}
                <div className="mt-1 space-y-0.5">
                  {phase.summaryOverride != null && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">summary →</span>{" "}
                      {phase.summaryOverride
                        ? t("codex.timeline.summaryQuoted", {
                            value: phase.summaryOverride,
                          })
                        : t("codex.timeline.empty")}
                    </p>
                  )}
                  {phase.contentOverride != null && (
                    <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">content →</span>
                      <FileText className="h-3 w-3 shrink-0" aria-hidden />
                      {t("codex.timeline.contentOverride")}
                    </p>
                  )}
                  {phase.contextModeOverride != null && (
                    <p className="text-[11px] text-muted-foreground">
                      <span className="text-foreground/60">context →</span>{" "}
                      {phase.contextModeOverride}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Fragment>
        );
      })}

      {/* 最後の Phase より後ろにいる場合の ▶ ここ */}
      {!currentMarker.missing &&
        currentMarker.insertBefore === sortedPhases.length &&
        currentMarkerRow}

      {/* アンカーなしフェーズ（末尾に表示） */}
      {unsortedPhases.map((phase) => (
        <div key={phase.id} className="flex gap-2">
          <div className="flex flex-col items-center">
            <span className="mt-1 text-xs text-muted-foreground">●</span>
            <div className="mt-1 w-px flex-1 bg-border" />
          </div>
          <div className="flex-1 pb-3 pt-0.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-xs font-semibold">{phase.label}</p>
                <p className="text-[10px] text-muted-foreground">
                  {t("codex.timeline.noAnchorScene")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => handleEdit(phase)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(phase.id)}
                  className="rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Add phase button */}
      <div className="flex gap-2">
        <div className="flex w-4 justify-center">
          <div className="h-3 w-px bg-border" />
        </div>
        <div className="pb-2" />
      </div>
      <button
        type="button"
        onClick={handleAdd}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("codex.timeline.addPhase")}
      </button>

      {/* Phase dialog */}
      {dialogOpen && (
        <PhaseDialog
          entryId={entry.id}
          phase={editingPhase}
          onClose={handleClose}
          resolveCurrentContent={resolveContentAtAnchor}
          existingDetailOverrideCount={
            editingPhase
              ? (detailOverrides[editingPhase.id]?.length ?? 0)
              : 0
          }
        />
      )}

      {/* Delete confirm dialog */}
      {confirmDeleteId && confirmPhase && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-80 rounded-lg border border-border bg-background p-5 shadow-xl">
            <p className="text-sm font-semibold">
              {t("codex.phase.deleteTitle")}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("codex.phase.deleteDesc", {
                name: confirmPhase.anchorNodeId
                  ? t("codex.phase.deleteNameWithScene", {
                      label: confirmPhase.label,
                      scene: getSceneTitle(confirmPhase.anchorNodeId),
                    })
                  : t("codex.phase.deleteName", { label: confirmPhase.label }),
              })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirm()}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90"
              >
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
