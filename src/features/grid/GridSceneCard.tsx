import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useNodeBeatPreview, useTreeStore } from "@/features/tree/treeStore";
import { StatusBadge } from "@/features/tree/StatusBadge";
import {
  prepareUnplacedBeatsForGrid,
  saveUnplacedBeatDraftFromGrid,
} from "@/features/editor/beat/addUnplacedBeatFromGrid";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { cn } from "@/lib/utils";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { markStart, markEnd, recordMark } from "@/lib/perfLog";
import { GridCardHeader } from "./GridCardHeader";
import { GridCardBody } from "./GridCardBody";
import { GridCardChips } from "./GridCardChips";
import { GridCardLabelBar } from "./GridCardLabelBar";
import { GridCardPovChips } from "./GridCardPovChips";
import { GridCardForeshadowIndicator } from "./GridCardForeshadowIndicator";
import { GridCardMenu } from "./GridCardMenu";
import { GridSceneCardContextMenu } from "./GridSceneCardContextMenu";
import { sceneDraggableId, sceneDroppableId } from "./gridDndUtils";
import type { GridDisplaySettings } from "./gridStore";
import { useGridStore } from "./gridStore";
import { useGridVirtualRowEditing } from "./gridVirtualEditingStore";
import { useQuiescentDraftParticipant } from "@/application/lifecycle/useQuiescentDraftParticipant";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { useLatestValueDraftController } from "@/application/lifecycle/latestValueDraftController";
import type { QuiescenceParticipantFlushOptions } from "@/application/lifecycle/quiescenceParticipants";

interface Props {
  scene: TreeNodeData;
  display: GridDisplaySettings;
  dimmed?: boolean;
  /** Whether this scene is the target of a drop indicator with position "before".
   *  Parent (column) computes this from its dropIndicator/columnDropIndicator
   *  state so unaffected cards stay referentially stable for React.memo. */
  isDropBefore?: boolean;
  /** Whether this scene is the target of a drop indicator with position "after". */
  isDropAfter?: boolean;
  /** Axis-locked drag: signed translateY pixels. Negative = up, positive =
   *  down. Applies to both passing siblings (one slot) and the active card
   *  itself (multi-slot) so the card travels visually with the swap. */
  axisLockOffsetPx?: number;
  /** Called when delete is requested (single or multi-select). */
  onRequestDeleteConfirm?: (sceneIds: string[]) => void;
  /** Flat scene order for range selection (Shift+Click). */
  flatOrder?: string[];
}

function GridSceneCardImpl({
  scene,
  display,
  dimmed,
  isDropBefore = false,
  isDropAfter = false,
  axisLockOffsetPx,
  onRequestDeleteConfirm,
  flatOrder,
}: Props) {
  const __perfStart = performance.now();
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [bodyEditing, setBodyEditing] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [addingBeat, setAddingBeat] = useState(false);
  const [beatDraft, setBeatDraft] = useState("");
  const beatInputRef = useRef<HTMLTextAreaElement>(null);
  const addingBeatRef = useRef(false);
  const mountedRef = useRef(true);
  const beatPrepareInFlightRef = useRef<Promise<void> | null>(null);
  const beatController = useLatestValueDraftController(
    `grid-add-beat:${scene.id}`,
    { beatId: "", text: "" },
    async (draft) => {
      if (!draft.beatId) {
        throw new Error(`Grid add Beat target is unavailable: ${scene.id}`);
      }
      await saveUnplacedBeatDraftFromGrid(scene.id, draft.beatId, draft.text);
    },
    (left, right) => left.beatId === right.beatId && left.text === right.text,
  );
  const isEditing = bodyEditing || titleEditing;
  useGridVirtualRowEditing(scene.id, isEditing || addingBeat);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const liveCharCount = useTreeStore(
    (s) => s.charCounts[scene.id] ?? scene.charCount ?? 0,
  );
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const preview = useNodeBeatPreview(scene.id);

  const isSelected = useGridStore((s) => s.selectedSceneIds.has(scene.id));
  const isRevealed = useGridStore((s) => s.revealedSceneId === scene.id);
  const selectOnly = useGridStore((s) => s.selectOnly);
  const toggleSelection = useGridStore((s) => s.toggleSelection);
  const rangeSelect = useGridStore((s) => s.rangeSelect);
  const clearSelection = useGridStore((s) => s.clearSelection);

  function requestDelete() {
    const { selectedSceneIds } = useGridStore.getState();
    const isMultiSelect =
      selectedSceneIds.has(scene.id) && selectedSceneIds.size > 1;
    if (isMultiSelect) {
      onRequestDeleteConfirm?.(Array.from(selectedSceneIds));
    } else {
      const needsConfirm = liveCharCount > 0 || !!scene.synopsis;
      if (needsConfirm && onRequestDeleteConfirm) {
        onRequestDeleteConfirm([scene.id]);
      } else {
        clearSelection();
        void deleteNode(scene.id);
      }
    }
  }

  const fileBacked = isFileBackedNode(scene.sourceUri);

  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: sceneDraggableId(scene.id),
    data: { kind: "scene", sceneId: scene.id },
    disabled: isEditing || addingBeat || fileBacked,
  });

  const { setNodeRef: setDropRef } = useDroppable({
    id: sceneDroppableId(scene.id),
    data: { kind: "scene-drop", sceneId: scene.id },
  });

  function openInEditor() {
    openEditorDocument(
      {
        target: { kind: "scene", documentId: scene.id },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      defaultEditorNavigationPorts,
    );
  }

  function startAddingBeat() {
    if (
      addingBeatRef.current ||
      beatPrepareInFlightRef.current ||
      bodyEditing ||
      titleEditing ||
      beatController.dirty
    ) {
      return;
    }
    const preparation = prepareUnplacedBeatsForGrid(scene.id);
    beatPrepareInFlightRef.current = preparation;
    void preparation
      .then(() => {
        if (
          !mountedRef.current ||
          beatPrepareInFlightRef.current !== preparation ||
          !canScheduleQuiescenceMutation()
        ) {
          return;
        }
        addingBeatRef.current = true;
        beatController.reset({ beatId: crypto.randomUUID(), text: "" });
        setAddingBeat(true);
        setBeatDraft("");
      })
      .catch(() => {
        // Do not open an editor whose aggregate could not be hydrated. Treating
        // an unavailable/malformed row as empty could overwrite existing Beats.
      })
      .finally(() => {
        if (beatPrepareInFlightRef.current === preparation) {
          beatPrepareInFlightRef.current = null;
        }
      });
  }

  async function commitBeat(
    options?: QuiescenceParticipantFlushOptions,
  ): Promise<void> {
    if (!addingBeatRef.current) return;
    await beatController.save(options);
    addingBeatRef.current = false;
    if (mountedRef.current) {
      setAddingBeat(false);
      setBeatDraft("");
    }
  }

  function cancelBeat() {
    if (!addingBeatRef.current) return;
    const current = beatController.latestValue;
    beatController.reset({ ...current, text: "" });
    addingBeatRef.current = false;
    if (mountedRef.current) {
      setAddingBeat(false);
      setBeatDraft("");
    }
  }

  useQuiescentDraftParticipant({
    id: `grid-add-beat:${scene.id}`,
    enabled: addingBeat,
    isDirty: () => addingBeatRef.current && beatController.dirty,
    flush: commitBeat,
    discard: cancelBeat,
    recovery: () =>
      addingBeatRef.current
        ? {
            kind: "grid-add-beat",
            sceneId: scene.id,
            beatId: beatController.latestValue.beatId,
            text: beatController.latestValue.text,
          }
        : null,
  });

  function handleBeatKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void commitBeat().catch(() => {});
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelBeat();
    }
  }

  // Auto-resize the add-beat textarea to fit content.
  useLayoutEffect(() => {
    if (!addingBeat) return;
    const el = beatInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [addingBeat, beatDraft]);

  function activateCard(e: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }) {
    if (e.metaKey || e.ctrlKey) {
      toggleSelection(scene.id);
    } else if (e.shiftKey) {
      rangeSelect(scene.id, flatOrder ?? []);
    } else {
      markStart("grid.cardClick.single");
      try {
        selectOnly(scene.id);
        openEditorDocument(
          {
            target: { kind: "scene", documentId: scene.id },
            mode: "preview",
            revealEditor: false,
            focusEditor: false,
            syncSceneContext: true,
          },
          defaultEditorNavigationPorts,
        );
      } finally {
        markEnd("grid.cardClick.single");
      }
    }
  }

  function isInteractiveDescendant(target: EventTarget | null) {
    return !!(target as HTMLElement | null)?.closest(
      "button, a, input, textarea, [contenteditable='true']",
    );
  }

  function handleCardClick(e: React.MouseEvent) {
    if (isEditing || addingBeat) return;
    // Ignore clicks on interactive descendants — they handle their own clicks
    if (isInteractiveDescendant(e.target)) return;
    activateCard(e);
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (isEditing || addingBeat) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    // Nested interactive elements (drag handle, menu, inputs…) own their keys
    if (isInteractiveDescendant(e.target)) return;
    e.preventDefault();
    activateCard(e);
  }

  const axisLockOffset = axisLockOffsetPx ?? 0;
  const [e0, e1, e2, e3] = EASINGS.easeOut;
  const axisLockTransition = reducedMotion
    ? "none"
    : `transform ${DURATIONS.fast}s cubic-bezier(${e0}, ${e1}, ${e2}, ${e3})`;

  const dragHandle = (
    <button
      type="button"
      {...(fileBacked ? {} : attributes)}
      {...(fileBacked ? {} : listeners)}
      onClick={(e) => e.stopPropagation()}
      aria-label={
        fileBacked
          ? t("externalMount.filenameOrder")
          : t("grid.card.dragHandle")
      }
      title={
        fileBacked
          ? t("externalMount.filenameOrder")
          : t("grid.card.dragHandle")
      }
      className={cn(
        "shrink-0 rounded p-0.5",
        fileBacked
          ? "cursor-not-allowed text-muted-foreground/30 opacity-30"
          : "cursor-grab active:cursor-grabbing text-muted-foreground/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:text-muted-foreground hover:bg-accent",
        "transition-opacity",
        isDragging && !fileBacked && "opacity-100",
      )}
      data-testid="grid-card-drag-handle"
    >
      <GripVertical className="h-3.5 w-3.5" />
    </button>
  );

  const __renderResult = (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      data-grid-scene-id={scene.id}
      className="relative"
      style={{
        transform: axisLockOffset
          ? `translateY(${axisLockOffset}px)`
          : undefined,
        transition: axisLockTransition,
        willChange: axisLockOffset ? "transform" : undefined,
      }}
    >
      {isDropBefore && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-1.5 h-1 rounded-full bg-primary"
        />
      )}
      {isDropAfter && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-1 rounded-full bg-primary"
        />
      )}
      <GridSceneCardContextMenu
        sceneId={scene.id}
        onOpenInEditor={openInEditor}
        onAddBeat={startAddingBeat}
        onDelete={requestDelete}
      >
        <div
          tabIndex={0}
          // role="group"(構造ロール)なので nested な button/input を含んでも
          // nested-interactive 違反にならない。選択状態は role 非依存の
          // aria-current で表す（aria-selected は listbox 前提のため不可）。
          role="group"
          aria-label={scene.title}
          aria-current={isSelected ? "true" : undefined}
          className={cn(
            "group relative rounded-md border bg-card text-card-foreground shadow-sm",
            "flex flex-col select-none outline-none",
            "focus-visible:ring-2 focus-visible:ring-ring",
            (isDragging || dimmed) && "opacity-40",
            isSelected && "ring-2 ring-primary border-primary/60 bg-primary/5",
            isRevealed &&
              "ring-2 ring-amber-400 border-amber-400/60 bg-amber-400/10",
          )}
          style={{ transition: "opacity 120ms ease-out" }}
          onClick={handleCardClick}
          onKeyDown={handleCardKeyDown}
        >
          {display.showLabelBar && <GridCardLabelBar nodeId={scene.id} />}

          <GridCardHeader
            nodeId={scene.id}
            title={scene.title}
            onOpenInEditor={openInEditor}
            onEditingChange={setTitleEditing}
            dragHandleSlot={dragHandle}
            menuSlot={
              <GridCardMenu nodeId={scene.id} onDelete={requestDelete} />
            }
          />

          <GridCardPovChips
            sceneId={scene.id}
            scenePovCharacterId={scene.povCharacterId}
            compact={display.compactCards}
          />

          <GridCardBody
            nodeId={scene.id}
            synopsis={scene.synopsis}
            unplacedBeatPreview={preview.unplaced}
            placedBeatPreview={preview.placed}
            showSynopsis={display.showSynopsis}
            showBeats={display.showBeats}
            compact={display.compactCards}
            onEditingChange={setBodyEditing}
            onRequestAddBeat={startAddingBeat}
            beatEditingDisabled={addingBeat}
          />

          {addingBeat && (
            <div className="px-3 pb-2">
              <textarea
                ref={beatInputRef}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                rows={1}
                className="w-full resize-none overflow-hidden rounded border border-input bg-background px-2 py-1 text-[11px] leading-snug focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder={t(
                  "grid.card.beatPlaceholder",
                  "Beat を入力… (Enter で確定 / Shift+Enter で改行)",
                )}
                value={beatDraft}
                onChange={(e) => {
                  beatController.markDirty({
                    ...beatController.latestValue,
                    text: e.target.value,
                  });
                  setBeatDraft(e.target.value);
                }}
                onKeyDown={handleBeatKeyDown}
                onBlur={() => void commitBeat().catch(() => {})}
                title={t(
                  "grid.card.beatEditHint",
                  "Enter で確定、Shift+Enter で改行、Esc で取消",
                )}
              />
            </div>
          )}

          {display.showCodex && (
            <div className="px-3 pb-2">
              <GridCardChips
                sceneId={scene.id}
                editable
                compact={display.compactCards}
              />
            </div>
          )}

          {/* Footer: status badge + foreshadow + char count */}
          <div className="flex items-center gap-2 px-3 pb-2 pt-1 border-t border-border/40 mt-0.5">
            <StatusBadge
              status={scene.status}
              iconOnly={!display.showStatusLabel}
            />
            {display.showForeshadow && (
              <GridCardForeshadowIndicator
                sceneId={scene.id}
                compact={display.compactCards}
              />
            )}
            <span className="text-[10px] text-muted-foreground/60 ml-auto">
              {liveCharCount.toLocaleString()} {t("common.unitChars")}
            </span>
          </div>
        </div>
      </GridSceneCardContextMenu>
    </div>
  );
  recordMark(
    "gridSceneCard.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}

// NOTE: dnd-kit の useDraggable/useDroppable が InternalContext を購読しており、
// pointer move のたびに `over` が変わって全 consumer が memo を貫通して再描画される。
// このため drag 中の `gridSceneCard.render` 削減効果はゼロ。一方 drag していない
// 通常時 (preview tab 切替、active scene 更新等) の浅比較 skip は機能している。
// `isDropBefore`/`isDropAfter` を primitive props にしてあるのは、将来 dnd-kit を
// 置換/除去したとき即座に memo が完全に効くようにするための前提。
export const GridSceneCard = memo(GridSceneCardImpl);
