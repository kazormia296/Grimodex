import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useCodexStore } from "@/features/codex/codexStore";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  resolveCodexState,
  computeSceneTimeIndex,
} from "@/features/codex/phaseResolver";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import type { CodexPhaseDetailOverride } from "@/db/schema";

const FALLBACK_TYPE_COLORS: Record<string, string> = {
  character: "#6B7ADB",
  location: "#5BAD8F",
  item: "#C27D3C",
  lore: "#9B6BB5",
};

interface PopoverState {
  visible: boolean;
  x: number;
  y: number;
  entryId: string | null;
}

interface CodexPopoverProps {
  editor?: Editor | null;
  /** DOM要素を直接渡す場合（editor不要のコンテナベースモード） */
  containerEl?: HTMLElement | null;
}

export function CodexPopover({ editor, containerEl }: CodexPopoverProps) {
  const entries = useCodexStore((s) => s.entries);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);
  const [popover, setPopover] = useState<PopoverState>({
    visible: false,
    x: 0,
    y: 0,
    entryId: null,
  });
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseOver = useCallback((e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.(".codex-highlight");
    if (!target) return;

    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }

    const entryId = target.getAttribute("data-codex-entry-id");
    if (!entryId) return;

    const rect = target.getBoundingClientRect();
    setPopover({
      visible: true,
      x: rect.left,
      y: rect.bottom + 4,
      entryId,
    });
  }, []);

  const handleMouseOut = useCallback((e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest?.(".codex-highlight");
    const relatedTarget = (e.relatedTarget as HTMLElement)?.closest?.(
      ".codex-popover",
    );
    if (target && !relatedTarget) {
      hideTimerRef.current = setTimeout(() => {
        setPopover((s) => ({ ...s, visible: false }));
      }, 200);
    }
  }, []);

  useEffect(() => {
    let dom: HTMLElement | null = null;
    if (containerEl) {
      dom = containerEl;
    } else if (editor && !editor.isDestroyed) {
      try {
        dom = editor.view.dom;
      } catch {
        // エディタがまだマウントされていない、または破棄済みの場合はスキップ
        return;
      }
    }
    if (!dom) return;
    dom.addEventListener("mouseover", handleMouseOver);
    dom.addEventListener("mouseout", handleMouseOut);
    return () => {
      dom!.removeEventListener("mouseover", handleMouseOver);
      dom!.removeEventListener("mouseout", handleMouseOut);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [editor, containerEl, handleMouseOver, handleMouseOut]);

  // Phase 解決: ポップオーバーが表示されたらエントリのフェーズをロードし、アクティブシーンで解決する
  useEffect(() => {
    if (!popover.visible || !popover.entryId) return;
    if (!phasesByEntry[popover.entryId]) {
      void usePhaseStore.getState().loadPhasesForEntry(popover.entryId);
    }
  }, [popover.visible, popover.entryId, phasesByEntry]);

  const resolvedPhase = useMemo(() => {
    const entryId = popover.entryId;
    if (!entryId) return null;
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) return null;
    const phases = phasesByEntry[entryId];
    if (!phases || phases.length === 0) return null;

    const phaseDetailsMap = new Map<string, CodexPhaseDetailOverride[]>();
    for (const phase of phases) {
      phaseDetailsMap.set(phase.id, detailOverrides[phase.id] ?? []);
    }
    const sceneOrder = computeSceneTimeIndex(nodes, resolutionMode);
    const resolved = resolveCodexState(
      {
        summary: entry.summary ?? null,
        content: entry.content,
        contextMode: entry.contextMode ?? "mentioned",
      },
      phases,
      phaseDetailsMap,
      new Map(),
      activeSceneId || null,
      sceneOrder,
    );
    const lastPhaseId =
      resolved.appliedPhaseIds[resolved.appliedPhaseIds.length - 1];
    const phaseLabel = lastPhaseId
      ? phases.find((p) => p.id === lastPhaseId)?.label
      : undefined;
    return { summary: resolved.summary, phaseLabel };
  }, [
    popover.entryId,
    entries,
    phasesByEntry,
    detailOverrides,
    nodes,
    resolutionMode,
    activeSceneId,
  ]);

  if (!popover.visible || !popover.entryId) return null;

  const entry = entries.find((e) => e.id === popover.entryId);
  if (!entry) return null;

  const dotColor =
    typeColorMap[entry.type]?.fg ??
    FALLBACK_TYPE_COLORS[entry.type] ??
    "#888888";
  function handleOpenInCodex() {
    setPopover((s) => ({ ...s, visible: false }));
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entry!.id);
  }

  return createPortal(
    <div
      className="codex-popover fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
      style={{ left: popover.x, top: popover.y }}
      data-testid="codex-popover"
      onMouseEnter={() => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }
      }}
      onMouseLeave={() => {
        setPopover((s) => ({ ...s, visible: false }));
      }}
    >
      <CodexEntryPopoverContent
        entry={entry}
        dotColor={dotColor}
        typeLabel={getTypeLabel(entry.type)}
        onOpenInCodex={handleOpenInCodex}
        phaseLabel={resolvedPhase?.phaseLabel}
        resolvedSummary={resolvedPhase?.summary}
      />
    </div>,
    document.body,
  );
}
