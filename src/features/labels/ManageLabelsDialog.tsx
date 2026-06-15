import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, GripVertical, Pencil, Trash2, Plus, Check } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { toast } from "sonner";
import { LABEL_PALETTE, PALETTE_SLOTS } from "@/lib/labelPalette";
import { useLabelStore } from "./labelStore";
import { countNodesWithLabel } from "./labelApi";
import type { Label } from "./labelApi";

// --- Color Swatch Picker ---
function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (slot: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 mt-1">
      {PALETTE_SLOTS.map((slot) => {
        const col = LABEL_PALETTE[slot];
        return (
          <button
            key={slot}
            title={col.label}
            className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
            style={{
              backgroundColor: col.light,
              borderColor: value === slot ? "#000" : "transparent",
            }}
            onClick={() => onChange(slot)}
          />
        );
      })}
    </div>
  );
}

// --- Delete Confirm ---
function DeleteConfirmDialog({
  label,
  nodeCount,
  onConfirm,
  onCancel,
}: {
  label: Label;
  nodeCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
      <div className="w-80 rounded-lg border bg-popover p-4 shadow-xl">
        <p className="text-sm font-medium">
          {t("labels.deleteConfirmTitle", "「{{name}}」を削除しますか？", {
            name: label.name,
          })}
        </p>
        {nodeCount > 0 && (
          <p className="mt-1 text-[12px] text-muted-foreground">
            {t(
              "labels.deleteConfirmDesc",
              "{{count}} 件のシーン・章から外されます。",
              { count: nodeCount },
            )}
          </p>
        )}
        <div className="mt-4 flex gap-2 justify-end">
          <button
            className="rounded px-3 py-1.5 text-sm hover:bg-accent"
            onClick={onCancel}
          >
            {t("common.cancel", "キャンセル")}
          </button>
          <button
            className="rounded bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t("common.delete", "削除")}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Sortable Label Row ---
function LabelRow({
  label,
  onEdit,
  onDelete,
}: {
  label: Label;
  onEdit: (label: Label) => void;
  onDelete: (label: Label) => void;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: label.id });
  const colorHex = LABEL_PALETTE[label.color]?.light ?? "#888888";

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-muted-foreground"
        aria-label={t("labels.reorder", "並べ替え")}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <span
        className="h-3 w-3 rounded-full shrink-0"
        style={{ backgroundColor: colorHex }}
      />
      <span className="flex-1 text-sm">{label.name}</span>
      <button
        className="rounded p-1 hover:bg-accent text-muted-foreground"
        onClick={() => onEdit(label)}
        aria-label={t("common.edit", "編集")}
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        className="rounded p-1 hover:bg-accent text-muted-foreground"
        onClick={() => onDelete(label)}
        aria-label={t("common.delete", "削除")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// --- Edit Form ---
function EditForm({
  label,
  onSave,
  onCancel,
}: {
  label: Label;
  onSave: (id: string, name: string, color: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div>
        <label className="mb-0.5 block text-xs font-medium">
          {t("labels.name", "名前")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs font-medium">
          {t("labels.color", "色")}
        </label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="flex gap-2 justify-end">
        <button
          className="rounded px-3 py-1 text-sm hover:bg-accent"
          onClick={onCancel}
        >
          {t("common.cancel", "キャンセル")}
        </button>
        <button
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
          onClick={() => {
            if (name.trim()) onSave(label.id, name.trim(), color);
          }}
        >
          <Check className="h-3.5 w-3.5 inline mr-1" />
          {t("common.save", "保存")}
        </button>
      </div>
    </div>
  );
}

// --- Add Form ---
function AddForm({
  onSave,
  onCancel,
}: {
  onSave: (name: string, color: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE_SLOTS[0]);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
      <div>
        <label className="mb-0.5 block text-xs font-medium">
          {t("labels.name", "名前")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          placeholder={t("labels.namePlaceholder", "ラベル名…")}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) onSave(name.trim(), color);
            if (e.key === "Escape") onCancel();
          }}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs font-medium">
          {t("labels.color", "色")}
        </label>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="flex gap-2 justify-end">
        <button
          className="rounded px-3 py-1 text-sm hover:bg-accent"
          onClick={onCancel}
        >
          {t("common.cancel", "キャンセル")}
        </button>
        <button
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
          onClick={() => {
            if (name.trim()) onSave(name.trim(), color);
          }}
        >
          <Plus className="h-3.5 w-3.5 inline mr-1" />
          {t("common.add", "追加")}
        </button>
      </div>
    </div>
  );
}

// --- Main Dialog ---
export function ManageLabelsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const labels = useLabelStore((s) => s.labels);
  const addLabel = useLabelStore((s) => s.addLabel);
  const updateLabelAction = useLabelStore((s) => s.updateLabel);
  const removeLabelAction = useLabelStore((s) => s.removeLabel);
  const reorderLabelsAction = useLabelStore((s) => s.reorderLabels);

  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    label: Label;
    nodeCount: number;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = labels.findIndex((l) => l.id === active.id);
      const newIndex = labels.findIndex((l) => l.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const reordered = [...labels];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);
      void reorderLabelsAction(reordered.map((l) => l.id));
    },
    [labels, reorderLabelsAction],
  );

  async function handleAdd(name: string, color: string) {
    setShowAdd(false);
    try {
      await addLabel({ name, color });
    } catch {
      toast.error(t("labels.addFailed", "ラベルの追加に失敗しました"));
    }
  }

  async function handleEdit(id: string, name: string, color: string) {
    setEditingId(null);
    try {
      await updateLabelAction(id, { name, color });
    } catch {
      toast.error(t("labels.updateFailed", "ラベルの更新に失敗しました"));
    }
  }

  async function requestDelete(label: Label) {
    const nodeCount = await countNodesWithLabel(label.id);
    setDeleteTarget({ label, nodeCount });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { label } = deleteTarget;
    setDeleteTarget(null);
    try {
      await removeLabelAction(label.id);
    } catch {
      toast.error(t("labels.deleteFailed", "ラベルの削除に失敗しました"));
    }
  }

  return (
    <>
      <AnimatedOverlay
        open={open}
        onClose={onClose}
        className="w-full max-w-md rounded-lg border bg-popover shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">
            {t("labels.manageTitle", "Label を管理")}
          </h2>
          <button
            className="rounded p-1 hover:bg-accent"
            onClick={onClose}
            aria-label={t("common.close", "閉じる")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Label list */}
        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-2">
          {labels.length === 0 && !showAdd && (
            <p className="text-center text-sm text-muted-foreground py-4">
              {t("labels.empty", "ラベルがありません")}
            </p>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={labels.map((l) => l.id)}
              strategy={verticalListSortingStrategy}
            >
              {labels.map((label) =>
                editingId === label.id ? (
                  <EditForm
                    key={label.id}
                    label={label}
                    onSave={(id, name, color) =>
                      void handleEdit(id, name, color)
                    }
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <LabelRow
                    key={label.id}
                    label={label}
                    onEdit={(l) => {
                      setShowAdd(false);
                      setEditingId(l.id);
                    }}
                    onDelete={(l) => void requestDelete(l)}
                  />
                ),
              )}
            </SortableContext>
          </DndContext>

          {showAdd && (
            <AddForm
              onSave={(name, color) => void handleAdd(name, color)}
              onCancel={() => setShowAdd(false)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="border-t px-4 py-3">
          <button
            className="flex items-center gap-1.5 rounded px-3 py-1.5 text-sm hover:bg-accent"
            onClick={() => {
              setEditingId(null);
              setShowAdd(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("labels.addNew", "新しいラベルを追加")}
          </button>
        </div>
      </AnimatedOverlay>

      {deleteTarget && (
        <DeleteConfirmDialog
          label={deleteTarget.label}
          nodeCount={deleteTarget.nodeCount}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
