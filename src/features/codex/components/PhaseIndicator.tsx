import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Clock, X } from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { resolveApplicablePhases } from "../context/resolveApplicablePhases";

const EMPTY_PHASES: CodexEntryPhase[] = [];

interface PhaseIndicatorProps {
  entry: CodexEntry;
  previewPhaseId: string | null;
  onPreviewChange: (phaseId: string | null) => void;
}

export function PhaseIndicator({
  entry,
  previewPhaseId,
  onPreviewChange,
}: PhaseIndicatorProps) {
  const { t } = useTranslation();
  const rawPhases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const phases = rawPhases ?? EMPTY_PHASES;
  const sceneTimeIndex = usePhaseStore((s) => s.sceneTimeIndex);
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const loadPhasesForEntry = usePhaseStore((s) => s.loadPhasesForEntry);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadPhasesForEntry(entry.id);
  }, [entry.id, loadPhasesForEntry]);

  // クリック外でドロップダウンを閉じる
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

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

  const sortedPhases =
    currentPhaseResolution?.axisUsed != null
      ? currentPhaseResolution.orderedPhases
      : latestPhaseResolution.orderedPhases;
  const activePhase = currentPhaseResolution
    ? (currentPhaseResolution.applicablePhases.at(-1) ?? null)
    : null;

  const getSceneTitle = (nodeId: string | null): string => {
    if (!nodeId) return "─";
    return nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  };

  // フェーズなし → 非表示
  if (phases.length === 0) return null;

  // プレビュー中のフェーズ（手動選択）または自動解決フェーズ
  const previewPhase =
    previewPhaseId != null && previewPhaseId !== "__base__"
      ? (sortedPhases.find((p) => p.id === previewPhaseId) ?? null)
      : null;
  const displayPhase = previewPhaseId != null ? previewPhase : activePhase;
  const isPreviewMode = previewPhaseId != null;

  const currentLabel = displayPhase
    ? `${displayPhase.label} (${getSceneTitle(displayPhase.anchorNodeId)})`
    : "Base state";

  return (
    <div
      ref={dropdownRef}
      className="relative mb-3 rounded-md border border-border bg-muted/30 px-3 py-2"
    >
      {/* フェーズセレクター */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          <Clock
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="flex-1 truncate text-xs font-medium">
            Phase: {currentLabel}
          </span>
          {isPreviewMode && (
            <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
              {t("codex.phaseIndicator.preview")}
            </span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
          />
        </button>
        {isPreviewMode && (
          <button
            type="button"
            onClick={() => onPreviewChange(null)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent"
            title={t("codex.phaseIndicator.exitPreview")}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* ミニタイムライン */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <span
          className={`rounded px-1 py-0.5 ${displayPhase == null ? "bg-primary/10 font-medium text-primary" : ""}`}
        >
          Base
        </span>
        {sortedPhases.map((phase) => {
          const isDisplay = phase.id === displayPhase?.id;
          return (
            <span key={phase.id} className="flex items-center gap-1">
              <span className="text-muted-foreground/50">→</span>
              <span
                className={`rounded px-1 py-0.5 ${
                  isDisplay
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground"
                }`}
              >
                {isDisplay ? `[${phase.label}]` : phase.label}
              </span>
            </span>
          );
        })}
      </div>

      {/* ドロップダウン */}
      {dropdownOpen && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-popover shadow-md">
          {/* Base state */}
          <button
            type="button"
            onClick={() => {
              // 自動解決がBase（activePhaseなし）の場合はプレビューをクリア
              onPreviewChange(
                !activePhase
                  ? null
                  : previewPhaseId === "__base__"
                    ? null
                    : "__base__",
              );
              setDropdownOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent ${previewPhaseId === "__base__" || (!isPreviewMode && !activePhase) ? "text-primary" : "text-foreground"}`}
          >
            <span>Base state</span>
            {!activePhase && !isPreviewMode && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                現在
              </span>
            )}
            {previewPhaseId === "__base__" && (
              <span className="ml-auto text-[10px] text-primary">
                プレビュー中
              </span>
            )}
          </button>
          {sortedPhases.map((phase) => {
            const isAutoActive = phase.id === activePhase?.id;
            const isPreviewSelected = phase.id === previewPhaseId;
            return (
              <button
                key={phase.id}
                type="button"
                onClick={() => {
                  // 自動解決フェーズをクリックした場合はプレビューをクリア
                  onPreviewChange(
                    isAutoActive
                      ? null
                      : previewPhaseId === phase.id
                        ? null
                        : phase.id,
                  );
                  setDropdownOpen(false);
                }}
                className={`flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs hover:bg-accent ${isPreviewSelected || (!isPreviewMode && isAutoActive) ? "text-primary" : "text-foreground"}`}
              >
                <span className="truncate">{phase.label}</span>
                <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                  {getSceneTitle(phase.anchorNodeId)}
                </span>
                {isAutoActive && !isPreviewMode && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    現在
                  </span>
                )}
                {isPreviewSelected && (
                  <span className="ml-auto text-[10px] text-primary">
                    プレビュー中
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
