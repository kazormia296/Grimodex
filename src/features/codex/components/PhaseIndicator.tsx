import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexEntryPhase } from "../phaseApi";
import { usePhaseStore } from "../phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";

const EMPTY_PHASES: CodexEntryPhase[] = [];

interface PhaseIndicatorProps {
  entry: CodexEntry;
}

export function PhaseIndicator({ entry }: PhaseIndicatorProps) {
  const rawPhases = usePhaseStore((s) => s.phasesByEntry[entry.id]);
  const phases = rawPhases ?? EMPTY_PHASES;
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
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

  // シーン順でソートされたフェーズ
  const sortedPhases = useMemo(() => {
    return [...phases]
      .filter(
        (p) => p.anchorNodeId != null && globalSceneOrder.has(p.anchorNodeId),
      )
      .sort(
        (a, b) =>
          globalSceneOrder.get(a.anchorNodeId!)! -
          globalSceneOrder.get(b.anchorNodeId!)!,
      );
  }, [phases, globalSceneOrder]);

  // 現在のアクティブフェーズ（シーン基準で自動解決）
  const activePhase = useMemo(() => {
    if (!activeSceneId) return null;
    const currentOrder = globalSceneOrder.get(activeSceneId);
    if (currentOrder === undefined) return null;
    const applicable = sortedPhases.filter(
      (p) => globalSceneOrder.get(p.anchorNodeId!)! <= currentOrder,
    );
    return applicable[applicable.length - 1] ?? null;
  }, [sortedPhases, globalSceneOrder, activeSceneId]);

  const getSceneTitle = (nodeId: string | null): string => {
    if (!nodeId) return "─";
    return nodes.find((n) => n.id === nodeId)?.title ?? nodeId;
  };

  // フェーズなし → 非表示
  if (phases.length === 0) return null;

  const currentLabel = activePhase
    ? `${activePhase.label} (${getSceneTitle(activePhase.anchorNodeId)})`
    : "Base state";

  return (
    <div
      ref={dropdownRef}
      className="relative mb-3 rounded-md border border-border bg-muted/30 px-3 py-2"
    >
      {/* フェーズセレクター */}
      <button
        type="button"
        onClick={() => setDropdownOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className="text-xs text-muted-foreground">⏱</span>
        <span className="flex-1 truncate text-xs font-medium">
          Phase: {currentLabel}
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${dropdownOpen ? "rotate-180" : ""}`}
        />
      </button>

      {/* ミニタイムライン */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <span
          className={`rounded px-1 py-0.5 ${!activePhase ? "bg-primary/10 font-medium text-primary" : ""}`}
        >
          Base
        </span>
        {sortedPhases.map((phase) => {
          const isActive = phase.id === activePhase?.id;
          return (
            <span key={phase.id} className="flex items-center gap-1">
              <span className="text-muted-foreground/50">→</span>
              <span
                className={`rounded px-1 py-0.5 ${
                  isActive
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground"
                }`}
              >
                {isActive ? `[${phase.label}]` : phase.label}
              </span>
            </span>
          );
        })}
      </div>

      {/* ドロップダウン */}
      {dropdownOpen && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-background shadow-md">
          {/* Base state */}
          <button
            type="button"
            onClick={() => setDropdownOpen(false)}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent ${!activePhase ? "text-primary" : "text-foreground"}`}
          >
            <span>Base state</span>
            {!activePhase && (
              <span className="ml-auto text-[10px] text-muted-foreground">
                現在
              </span>
            )}
          </button>
          {sortedPhases.map((phase) => {
            const isActive = phase.id === activePhase?.id;
            return (
              <button
                key={phase.id}
                type="button"
                onClick={() => setDropdownOpen(false)}
                className={`flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs hover:bg-accent ${isActive ? "text-primary" : "text-foreground"}`}
              >
                <span className="truncate">{phase.label}</span>
                <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
                  {getSceneTitle(phase.anchorNodeId)}
                </span>
                {isActive && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    現在
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
