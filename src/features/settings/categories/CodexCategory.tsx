import { useState, useEffect, useCallback } from "react";
import { Plus, Pencil, Trash2, Check, X } from "lucide-react";
import { toast } from "sonner";
import { SettingSection } from "../components/SettingSection";
import type { CodexType } from "@/features/codex/typeApi";
import {
  listCodexTypes,
  ensureBuiltinTypes,
  createCodexType,
  updateCodexType,
  deleteCodexType,
  codexTypeHasEntries,
} from "@/features/codex/typeApi";
import { useWorkspaceStore } from "@/features/workspace/store";
import {
  COLOR_THEMES,
  DEFAULT_COLOR_THEME,
  PALETTE_SIZE,
} from "@/lib/colorThemes";

const PROJECT_ID = "default-project";

// --- Palette Swatch Picker ---

interface PaletteSwatchPickerProps {
  selectedIndex: number | null;
  usedIndices: Map<number, string>; // index -> type label that uses it
  onChange: (index: number) => void;
}

function PaletteSwatchPicker({
  selectedIndex,
  usedIndices,
  onChange,
}: PaletteSwatchPickerProps) {
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const isDark = document.documentElement.classList.contains("dark");
  const resolvedId = colorTheme ?? DEFAULT_COLOR_THEME;
  const theme = COLOR_THEMES.find((t) => t.id === resolvedId);
  const palette = theme
    ? isDark
      ? theme.palette.dark
      : theme.palette.light
    : null;

  if (!palette) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {palette.slice(0, PALETTE_SIZE).map((slot, i) => {
        const isSelected = selectedIndex === i;
        const usedBy = usedIndices.get(i);
        return (
          <button
            key={i}
            type="button"
            title={usedBy ? `${slot.label}（${usedBy}が使用中）` : slot.label}
            onClick={() => onChange(i)}
            className="relative h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
            style={{
              backgroundColor: slot.hl,
              borderColor: isSelected ? slot.tx : "transparent",
              outline: isSelected ? `2px solid ${slot.tx}` : "none",
              outlineOffset: "1px",
            }}
          >
            <span
              className="absolute inset-1 rounded-full"
              style={{ backgroundColor: slot.fg }}
            />
            {usedBy && !isSelected && (
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border border-background bg-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// --- Type Row ---

interface TypeRowProps {
  type: CodexType;
  dotColor: string;
  onEdit: (type: CodexType) => void;
  onDelete: (type: CodexType) => void;
}

function TypeRow({ type, dotColor, onEdit, onDelete }: TypeRowProps) {
  return (
    <div
      data-testid={`codex-type-row-${type.slug}`}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
    >
      <span
        className="h-3 w-3 rounded-full shrink-0"
        style={{ backgroundColor: dotColor }}
      />
      <span className="flex-1 text-sm">{type.label}</span>
      <span className="text-[10px] text-muted-foreground">{type.slug}</span>
      {type.isBuiltin === 1 && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          builtin
        </span>
      )}
      <button
        type="button"
        data-testid={`codex-type-edit-${type.slug}`}
        onClick={() => onEdit(type)}
        className="rounded p-1 text-muted-foreground hover:bg-accent"
        title="編集"
      >
        <Pencil className="h-3 w-3" />
      </button>
      {type.isBuiltin === 0 && (
        <button
          type="button"
          data-testid={`codex-type-delete-${type.slug}`}
          onClick={() => onDelete(type)}
          className="rounded p-1 text-destructive hover:bg-destructive/10"
          title="削除"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// --- Edit Form ---

interface EditFormProps {
  type: CodexType;
  usedIndices: Map<number, string>;
  onSave: (updated: CodexType) => void;
  onCancel: () => void;
}

function EditForm({ type, usedIndices, onSave, onCancel }: EditFormProps) {
  const [label, setLabel] = useState(type.label);
  const [paletteIndex, setPaletteIndex] = useState<number | null>(
    type.paletteIndex ?? null,
  );

  const handleSave = async () => {
    if (!label.trim()) return;
    const updated = await updateCodexType(type.id, {
      label: label.trim(),
      ...(paletteIndex !== null ? { paletteIndex } : {}),
    });
    if (updated) onSave(updated);
  };

  return (
    <div
      data-testid={`codex-type-edit-form-${type.slug}`}
      className="rounded-md border border-border bg-muted/30 p-3 space-y-2"
    >
      <div className="flex items-center gap-2">
        <input
          data-testid={`codex-type-label-input-${type.slug}`}
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          placeholder="ラベル名"
        />
        <button
          type="button"
          data-testid={`codex-type-save-${type.slug}`}
          onClick={() => void handleSave()}
          className="rounded p-1.5 text-primary hover:bg-accent"
          title="保存"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent"
          title="キャンセル"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <PaletteSwatchPicker
        selectedIndex={paletteIndex}
        usedIndices={usedIndices}
        onChange={setPaletteIndex}
      />
      {type.isBuiltin === 1 && (
        <p className="text-[10px] text-muted-foreground">
          ※ ビルトインタイプはslugとisBuiltin属性を変更できません
        </p>
      )}
    </div>
  );
}

// --- Add Form ---

interface AddFormProps {
  usedIndices: Map<number, string>;
  onSave: (type: CodexType) => void;
  onCancel: () => void;
  maxSortOrder: number;
}

function AddForm({
  usedIndices,
  onSave,
  onCancel,
  maxSortOrder,
}: AddFormProps) {
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [paletteIndex, setPaletteIndex] = useState<number | null>(null);

  const handleSave = async () => {
    if (!label.trim() || !slug.trim()) return;
    try {
      const type = await createCodexType({
        projectId: PROJECT_ID,
        slug: slug.trim(),
        label: label.trim(),
        ...(paletteIndex !== null ? { paletteIndex } : {}),
        sortOrder: maxSortOrder + 1.0,
      });
      onSave(type);
    } catch {
      toast.error("タイプの作成に失敗しました");
    }
  };

  return (
    <div
      data-testid="codex-type-add-form"
      className="rounded-md border border-border bg-muted/30 p-3 space-y-2"
    >
      <div className="flex items-center gap-2">
        <input
          data-testid="codex-type-add-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="ラベル名"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          autoFocus
        />
      </div>
      <div className="flex items-center gap-2">
        <label className="w-12 text-xs text-muted-foreground shrink-0">
          slug
        </label>
        <input
          data-testid="codex-type-add-slug"
          type="text"
          value={slug}
          onChange={(e) =>
            setSlug(e.target.value.toLowerCase().replace(/\s+/g, "_"))
          }
          placeholder="type_slug"
          className="flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
        />
      </div>
      <PaletteSwatchPicker
        selectedIndex={paletteIndex}
        usedIndices={usedIndices}
        onChange={setPaletteIndex}
      />
      <p className="text-[10px] text-muted-foreground">
        ※ 色を選ばない場合は空き色が自動割当されます
      </p>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="codex-type-add-cancel"
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          キャンセル
        </button>
        <button
          type="button"
          data-testid="codex-type-add-save"
          onClick={() => void handleSave()}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          追加
        </button>
      </div>
    </div>
  );
}

// --- Main Category ---

export function CodexCategory() {
  const [types, setTypes] = useState<CodexType[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [deletingType, setDeletingType] = useState<CodexType | null>(null);

  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const isDark = document.documentElement.classList.contains("dark");
  const resolvedId = colorTheme ?? DEFAULT_COLOR_THEME;
  const theme = COLOR_THEMES.find((t) => t.id === resolvedId);
  const palette = theme
    ? isDark
      ? theme.palette.dark
      : theme.palette.light
    : null;

  const load = useCallback(async () => {
    await ensureBuiltinTypes(PROJECT_ID);
    const list = await listCodexTypes(PROJECT_ID);
    setTypes(list);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleEditSave = (updated: CodexType) => {
    setTypes((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditingId(null);
  };

  const handleAddSave = (newType: CodexType) => {
    setTypes((prev) => [...prev, newType]);
    setShowAddForm(false);
  };

  const handleDeleteClick = async (type: CodexType) => {
    const hasEntries = await codexTypeHasEntries(PROJECT_ID, type.slug);
    if (hasEntries) {
      toast.error(
        `「${type.label}」タイプのエントリが存在するため削除できません`,
      );
      return;
    }
    setDeletingType(type);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingType) return;
    await deleteCodexType(deletingType.id);
    setTypes((prev) => prev.filter((t) => t.id !== deletingType.id));
    setDeletingType(null);
    toast.success(`「${deletingType.label}」を削除しました`);
  };

  const maxSortOrder = Math.max(0, ...types.map((t) => t.sortOrder));

  // Map of paletteIndex -> label for showing usage in swatch picker
  const usedIndices = new Map<number, string>(
    types
      .filter((t) => t.paletteIndex !== null && t.paletteIndex !== undefined)
      .map((t) => [t.paletteIndex as number, t.label]),
  );

  // Resolve dot color for TypeRow
  const getDotColor = (type: CodexType): string => {
    if (
      palette &&
      type.paletteIndex !== null &&
      type.paletteIndex !== undefined
    ) {
      return palette[type.paletteIndex % PALETTE_SIZE]?.fg ?? type.color;
    }
    return type.color;
  };

  return (
    <div className="space-y-6" data-testid="codex-category">
      <SettingSection title="Codexタイプ管理">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Codexエントリのタイプを管理します。ビルトインタイプはラベルと色のみ変更できます。
          </p>

          <div className="space-y-1.5">
            {types.map((type) => (
              <div key={type.id}>
                {editingId === type.id ? (
                  <EditForm
                    type={type}
                    usedIndices={usedIndices}
                    onSave={handleEditSave}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <TypeRow
                    type={type}
                    dotColor={getDotColor(type)}
                    onEdit={(t) => setEditingId(t.id)}
                    onDelete={(t) => void handleDeleteClick(t)}
                  />
                )}
              </div>
            ))}
          </div>

          {showAddForm ? (
            <AddForm
              usedIndices={usedIndices}
              onSave={handleAddSave}
              onCancel={() => setShowAddForm(false)}
              maxSortOrder={maxSortOrder}
            />
          ) : (
            <button
              type="button"
              data-testid="codex-type-add-button"
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              <Plus className="h-3 w-3" />
              カスタムタイプを追加
            </button>
          )}
        </div>
      </SettingSection>

      {/* Delete Confirm */}
      {deletingType && (
        <div
          data-testid="codex-type-delete-confirm"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setDeletingType(null)}
        >
          <div
            className="w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="mb-2 text-sm font-semibold">
              タイプを削除しますか？
            </h4>
            <p className="mb-4 text-xs text-muted-foreground">
              「{deletingType.label}」（{deletingType.slug}
              ）を削除します。この操作は元に戻せません。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="codex-type-delete-cancel"
                onClick={() => setDeletingType(null)}
                className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
              >
                キャンセル
              </button>
              <button
                type="button"
                data-testid="codex-type-delete-confirm-button"
                onClick={() => void handleDeleteConfirm()}
                className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground"
              >
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
