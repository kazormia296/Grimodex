import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { cn } from "@/lib/utils";
import { ReorderCard } from "./ReorderCard";
import type { ReorderGranularity, ReorderUnit } from "./types";

interface ReorderOverlayProps {
  open: boolean;
  units: ReorderUnit[];
  order: number[];
  onOrderChange: (order: number[]) => void;
  granularity: ReorderGranularity;
  onGranularityChange: (g: ReorderGranularity) => void;
  loading: boolean;
  errorMessage: string | null;
  canConfirm: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  bunsetsuAvailable: boolean;
  phraseAvailable: boolean;
  wordAvailable: boolean;
}

export function ReorderOverlay({
  open,
  units,
  order,
  onOrderChange,
  granularity,
  onGranularityChange,
  loading,
  errorMessage,
  canConfirm,
  onConfirm,
  onCancel,
  bunsetsuAvailable,
  phraseAvailable,
  wordAvailable,
}: ReorderOverlayProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  if (!open) return null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(Number(active.id));
    const newIndex = order.indexOf(Number(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onOrderChange(arrayMove(order, oldIndex, newIndex));
  };

  const content = (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-background/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("editor.reorder.title")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="flex max-h-[min(80vh,640px)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{t("editor.reorder.title")}</h2>
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 p-0.5 text-xs">
            <button
              type="button"
              className={cn(
                "rounded px-2 py-0.5",
                granularity === "sentence" && "bg-background shadow-sm",
              )}
              onClick={() => onGranularityChange("sentence")}
            >
              {t("editor.reorder.granularitySentence")}
            </button>
            <button
              type="button"
              disabled={!phraseAvailable}
              className={cn(
                "rounded px-2 py-0.5 disabled:opacity-40",
                granularity === "phrase" && "bg-background shadow-sm",
              )}
              onClick={() => onGranularityChange("phrase")}
            >
              {t("editor.reorder.granularityPhrase")}
            </button>
            <button
              type="button"
              disabled={!wordAvailable}
              className={cn(
                "rounded px-2 py-0.5 disabled:opacity-40",
                granularity === "word" && "bg-background shadow-sm",
              )}
              onClick={() => onGranularityChange("word")}
            >
              {t("editor.reorder.granularityWord")}
            </button>
            <button
              type="button"
              disabled={!bunsetsuAvailable}
              className={cn(
                "rounded px-2 py-0.5 disabled:opacity-40",
                granularity === "bunsetsu" && "bg-background shadow-sm",
              )}
              onClick={() => onGranularityChange("bunsetsu")}
            >
              {t("editor.reorder.granularityBunsetsu")}
            </button>
            <button
              type="button"
              className={cn(
                "rounded px-2 py-0.5",
                granularity === "character" && "bg-background shadow-sm",
              )}
              onClick={() => onGranularityChange("character")}
            >
              {t("editor.reorder.granularityCharacter")}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loading && (
            <p className="text-sm text-muted-foreground">
              {t("editor.reorder.loading")}
            </p>
          )}
          {errorMessage && !loading && (
            <p className="mb-2 text-sm text-amber-600 dark:text-amber-400">
              {t(`editor.reorder.${errorMessage}`)}
            </p>
          )}
          {!loading && order.length > 0 && (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={order.map(String)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-2">
                  {order.map((unitIdx) => {
                    const unit = units[unitIdx];
                    if (!unit) return null;
                    return (
                      <ReorderCard
                        key={String(unitIdx)}
                        id={String(unitIdx)}
                        surface={unit.surface}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
            onClick={onCancel}
          >
            {t("editor.reorder.cancel")}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            onClick={onConfirm}
          >
            {t("editor.reorder.confirm")}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
