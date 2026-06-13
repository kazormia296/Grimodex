import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { X, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import type { CodexDetailDefinition } from "../detailApi";
import {
  listDefinitionsByType,
  createDefinition,
  updateDefinition,
  deleteDefinition,
} from "../detailApi";
import {
  PRESET_GENRES,
  applyDetailPreset,
  resolvePresetFields,
  type DetailFieldPreset,
} from "../detailPresets";
import {
  listEmptyDetailFields,
  deleteEmptyDetailFields,
} from "../detailCleanup";
import { getCurrentProjectLanguage } from "@/features/project/projectStore";

// --- Field type labels ---
const FIELD_TYPE_OPTIONS = [
  { value: "text", label: "Text" },
  { value: "dropdown", label: "Dropdown" },
  { value: "codex_reference", label: "Codex Reference" },
];

/** textarea の生入力を選択肢配列へ（trim・空行除去・重複排除） */
function parseOptionsInput(raw: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    options.push(trimmed);
  }
  return options;
}

function optionsToFieldConfig(
  fieldType: string,
  raw: string,
): string | null | undefined {
  if (fieldType !== "dropdown") return null;
  const options = parseOptionsInput(raw);
  // dropdown は選択肢必須（空 options の機能不全フィールドを作らせない）
  if (options.length === 0) return undefined;
  return JSON.stringify({ options });
}

function fieldConfigToOptionsText(fieldConfig: string | null): string {
  try {
    const config = JSON.parse(fieldConfig ?? "{}") as { options?: string[] };
    return (config.options ?? []).join("\n");
  } catch {
    return "";
  }
}

// --- Inline Add Form ---
interface AddFormProps {
  projectId: string;
  typeSlug: string;
  maxSortOrder: number;
  onSave: (def: CodexDetailDefinition) => void;
  onCancel: () => void;
}

function AddForm({
  projectId,
  typeSlug,
  maxSortOrder,
  onSave,
  onCancel,
}: AddFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [includeInContext, setIncludeInContext] = useState(false);
  const [optionsText, setOptionsText] = useState("");

  const handleSave = async () => {
    if (!name.trim()) return;
    const fieldConfig = optionsToFieldConfig(fieldType, optionsText);
    if (fieldConfig === undefined) return;
    const def = await createDefinition({
      id: crypto.randomUUID(),
      projectId,
      typeSlug,
      name: name.trim(),
      fieldType,
      fieldConfig,
      includeInContext: includeInContext ? 1 : 0,
      sortOrder: maxSortOrder + 1.0,
    });
    onSave(def);
  };

  return (
    <div
      data-testid="manage-field-add-form"
      className="rounded-md border border-border bg-muted/30 p-3 space-y-2"
    >
      <div>
        <label className="mb-0.5 block text-xs font-medium">Name</label>
        <input
          data-testid="manage-field-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          placeholder={t("codex.detail.fieldNamePlaceholder")}
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs font-medium">Type</label>
        <select
          data-testid="manage-field-type-select"
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          {FIELD_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {fieldType === "dropdown" && (
        <div>
          <label className="mb-0.5 block text-xs font-medium">
            {t("codex.detail.optionsLabel")}
          </label>
          <textarea
            data-testid="manage-field-options-input"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input
          data-testid="manage-field-context-checkbox"
          type="checkbox"
          checked={includeInContext}
          onChange={(e) => setIncludeInContext(e.target.checked)}
        />
        Include in AI context
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="manage-field-cancel-button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="manage-field-save-button"
          onClick={() => void handleSave()}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// --- Inline Edit Form ---
interface EditFormProps {
  definition: CodexDetailDefinition;
  onSave: (def: CodexDetailDefinition) => void;
  onCancel: () => void;
}

function EditForm({ definition, onSave, onCancel }: EditFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(definition.name);
  const [fieldType, setFieldType] = useState(definition.fieldType);
  const [includeInContext, setIncludeInContext] = useState(
    definition.includeInContext === 1,
  );
  const [optionsText, setOptionsText] = useState(() =>
    fieldConfigToOptionsText(definition.fieldConfig),
  );

  const handleSave = async () => {
    if (!name.trim()) return;
    const fieldConfig = optionsToFieldConfig(fieldType, optionsText);
    if (fieldConfig === undefined) return;
    const updated = await updateDefinition(definition.id, {
      name: name.trim(),
      fieldType,
      fieldConfig,
      includeInContext: includeInContext ? 1 : 0,
    });
    if (updated) onSave(updated);
  };

  return (
    <div
      data-testid={`manage-field-edit-form-${definition.id}`}
      className="mt-1 rounded-md border border-border bg-muted/30 p-3 space-y-2"
    >
      <div>
        <label className="mb-0.5 block text-xs font-medium">Name</label>
        <input
          data-testid={`manage-field-edit-name-${definition.id}`}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="mb-0.5 block text-xs font-medium">Type</label>
        <select
          data-testid={`manage-field-edit-type-${definition.id}`}
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          {FIELD_TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {fieldType === "dropdown" && (
        <div>
          <label className="mb-0.5 block text-xs font-medium">
            {t("codex.detail.optionsLabel")}
          </label>
          <textarea
            data-testid={`manage-field-edit-options-${definition.id}`}
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-xs">
        <input
          data-testid={`manage-field-edit-context-${definition.id}`}
          type="checkbox"
          checked={includeInContext}
          onChange={(e) => setIncludeInContext(e.target.checked)}
        />
        Include in AI context
      </label>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid={`manage-field-edit-cancel-${definition.id}`}
          onClick={onCancel}
          className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid={`manage-field-edit-save-${definition.id}`}
          onClick={() => void handleSave()}
          className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// --- Delete Confirm Dialog ---
interface DeleteConfirmProps {
  definitionName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function DeleteConfirmDialog({
  definitionName,
  onConfirm,
  onCancel,
}: DeleteConfirmProps) {
  // 親の ManageFieldsDialog (AnimatedOverlay) は body へ portal された z-50。
  // その上に確実に重ねるため、こちらも body へ portal して z-[60] にする。
  return createPortal(
    <div
      data-testid="manage-field-delete-confirm-dialog"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 text-sm font-semibold">
          フィールドを削除しますか？
        </h4>
        <p className="mb-4 text-xs text-muted-foreground">
          「{definitionName}
          」を削除すると、このタイプの全エントリからこのフィールドの値が完全に削除されます。この操作は元に戻せません。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="manage-field-delete-cancel-button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            data-testid="manage-field-delete-confirm-button"
            onClick={onConfirm}
            className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
          >
            削除
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Preset Confirm Dialog ---
interface PresetConfirmProps {
  toAdd: DetailFieldPreset[];
  toSkip: DetailFieldPreset[];
  onConfirm: () => void;
  onCancel: () => void;
}

function PresetConfirmDialog({
  toAdd,
  toSkip,
  onConfirm,
  onCancel,
}: PresetConfirmProps) {
  const { t } = useTranslation();
  // portal された親 (z-50) の上に重ねるため body へ portal して z-[60]
  return createPortal(
    <div
      data-testid="manage-fields-preset-confirm-dialog"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-96 rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 text-sm font-semibold">
          {t("codex.detail.presetConfirmTitle")}
        </h4>
        <p className="mb-1 text-xs font-medium">
          {t("codex.detail.presetConfirmAdd", { count: toAdd.length })}
        </p>
        <ul className="mb-3 max-h-48 overflow-y-auto text-xs space-y-0.5">
          {toAdd.map((field) => (
            <li key={field.name} className="flex items-baseline gap-1.5">
              <span>・{field.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {field.fieldType}
              </span>
              {field.options && (
                <span className="truncate text-[10px] text-muted-foreground">
                  {field.options.join(" / ")}
                </span>
              )}
            </li>
          ))}
        </ul>
        {toSkip.length > 0 && (
          <div data-testid="manage-fields-preset-skip" className="mb-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t("codex.detail.presetConfirmSkip", { count: toSkip.length })}
            </p>
            <ul className="max-h-24 overflow-y-auto text-xs text-muted-foreground space-y-0.5">
              {toSkip.map((field) => (
                <li key={field.name} className="truncate">
                  ・{field.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="manage-fields-preset-cancel-button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="manage-fields-preset-confirm-button"
            onClick={onConfirm}
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
          >
            {t("codex.detail.presetApply")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Cleanup Confirm Dialog ---
interface CleanupConfirmProps {
  targets: CodexDetailDefinition[];
  onConfirm: () => void;
  onCancel: () => void;
}

function CleanupConfirmDialog({
  targets,
  onConfirm,
  onCancel,
}: CleanupConfirmProps) {
  const { t } = useTranslation();
  // DeleteConfirmDialog 同様、portal された親 (z-50) の上に重ねるため
  // body へ portal して z-[60]
  return createPortal(
    <div
      data-testid="manage-fields-cleanup-confirm-dialog"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onClick={onCancel}
    >
      <div
        className="w-80 rounded-lg border border-border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="mb-2 text-sm font-semibold">
          {t("codex.detail.deleteEmptyConfirmTitle")}
        </h4>
        <p className="mb-2 text-xs text-muted-foreground">
          {t("codex.detail.deleteEmptyConfirmBody", { count: targets.length })}
        </p>
        <ul className="mb-4 max-h-32 overflow-y-auto text-xs">
          {targets.map((d) => (
            <li key={d.id} className="truncate">
              ・{d.name}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="manage-fields-cleanup-cancel-button"
            onClick={onCancel}
            className="rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="manage-fields-cleanup-confirm-button"
            onClick={onConfirm}
            className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90"
          >
            {t("common.delete")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --- Main Dialog ---
interface ManageFieldsDialogProps {
  projectId: string;
  typeSlug: string;
  typeLabel: string;
  open: boolean;
  onClose: () => void;
  /** プリセットピッカーの初期選択に使う projects.genre の値 */
  projectGenre?: string | null;
}

export function ManageFieldsDialog({
  projectId,
  typeSlug,
  typeLabel,
  open,
  onClose,
  projectGenre,
}: ManageFieldsDialogProps) {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<CodexDetailDefinition[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingDef, setDeletingDef] = useState<CodexDetailDefinition | null>(
    null,
  );
  // sample project 等は genre を小文字 ("fantasy") で保存しているため緩く照合
  const presetDefault = projectGenre
    ? (PRESET_GENRES.find(
        (g) => g.toLowerCase() === projectGenre.toLowerCase(),
      ) ?? "")
    : "";
  const [presetGenre, setPresetGenre] = useState(presetDefault);
  const [presetBusy, setPresetBusy] = useState(false);
  const [presetPreview, setPresetPreview] = useState<{
    toAdd: DetailFieldPreset[];
    toSkip: DetailFieldPreset[];
  } | null>(null);
  const [cleanupTargets, setCleanupTargets] = useState<
    CodexDetailDefinition[] | null
  >(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const load = useCallback(async () => {
    const defs = await listDefinitionsByType(projectId, typeSlug);
    setDefinitions(defs);
  }, [projectId, typeSlug]);

  useEffect(() => {
    if (open) {
      void load();
      setPresetGenre(presetDefault);
    }
  }, [open, load, presetDefault]);

  const handlePresetPreview = () => {
    // プリセットのフィールド名/選択肢は project 言語でシードする (en=英語)。
    const resolved = resolvePresetFields(
      typeSlug,
      presetGenre || null,
      getCurrentProjectLanguage(),
    );
    const existingNames = new Set(definitions.map((d) => d.name));
    const toAdd = resolved.filter((f) => !existingNames.has(f.name));
    if (toAdd.length === 0) {
      toast.info(t("codex.detail.presetNoneAdded"));
      return;
    }
    setPresetPreview({
      toAdd,
      toSkip: resolved.filter((f) => existingNames.has(f.name)),
    });
  };

  const handleApplyPreset = async () => {
    setPresetPreview(null);
    if (presetBusy) return;
    setPresetBusy(true);
    try {
      const result = await applyDetailPreset(
        projectId,
        typeSlug,
        presetGenre || null,
        getCurrentProjectLanguage(),
      );
      await load();
      if (result.added.length === 0) {
        toast.info(t("codex.detail.presetNoneAdded"));
      } else if (result.skipped > 0) {
        toast.success(
          t("codex.detail.presetAppliedSkipped", {
            added: result.added.length,
            skipped: result.skipped,
          }),
        );
      } else {
        toast.success(
          t("codex.detail.presetApplied", { count: result.added.length }),
        );
      }
    } catch {
      toast.error(t("common.error", "エラーが発生しました"));
    } finally {
      setPresetBusy(false);
    }
  };

  const handleCleanupClick = async () => {
    if (cleanupBusy) return;
    setCleanupBusy(true);
    try {
      const targets = await listEmptyDetailFields(projectId, typeSlug);
      if (targets.length === 0) {
        toast.info(t("codex.detail.deleteEmptyNone"));
      } else {
        setCleanupTargets(targets);
      }
    } catch {
      toast.error(t("common.error", "エラーが発生しました"));
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleCleanupConfirm = async () => {
    setCleanupTargets(null);
    try {
      const result = await deleteEmptyDetailFields(projectId, typeSlug);
      await load();
      toast.success(
        t("codex.detail.deleteEmptyDone", { count: result.deleted.length }),
      );
    } catch {
      toast.error(t("common.error", "エラーが発生しました"));
    }
  };

  const handleAddSave = (def: CodexDetailDefinition) => {
    setDefinitions((prev) => [...prev, def]);
    setShowAddForm(false);
  };

  const handleEditSave = (updated: CodexDetailDefinition) => {
    setDefinitions((prev) =>
      prev.map((d) => (d.id === updated.id ? updated : d)),
    );
    setEditingId(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingDef) return;
    await deleteDefinition(deletingDef.id);
    setDefinitions((prev) => prev.filter((d) => d.id !== deletingDef.id));
    setDeletingDef(null);
  };

  const maxSortOrder = Math.max(0, ...definitions.map((d) => d.sortOrder));

  return (
    <>
      <AnimatedOverlay
        open={open}
        onClose={onClose}
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-lg border border-border bg-background shadow-lg"
        backdropClassName="bg-black/40"
        testId="manage-fields-dialog"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">Manage fields: {typeLabel}</h3>
          <button
            type="button"
            data-testid="manage-fields-close-button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {definitions.map((def) => (
            <div key={def.id}>
              <div
                data-testid={`manage-field-row-${def.id}`}
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <span className="flex-1 text-sm">{def.name}</span>
                <span
                  data-testid={`manage-field-type-${def.id}`}
                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {def.fieldType === "codex_reference"
                    ? "codex_ref"
                    : def.fieldType}
                </span>
                <button
                  type="button"
                  data-testid={`manage-field-edit-${def.id}`}
                  onClick={() =>
                    setEditingId(editingId === def.id ? null : def.id)
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-accent"
                  title={t("common.edit")}
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  data-testid={`manage-field-delete-${def.id}`}
                  onClick={() => setDeletingDef(def)}
                  className="rounded p-1 text-destructive hover:bg-destructive/10"
                  title={t("common.delete")}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>

              {editingId === def.id && (
                <EditForm
                  definition={def}
                  onSave={handleEditSave}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          ))}

          {showAddForm && (
            <AddForm
              projectId={projectId}
              typeSlug={typeSlug}
              maxSortOrder={maxSortOrder}
              onSave={handleAddSave}
              onCancel={() => setShowAddForm(false)}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            data-testid="manage-fields-add-button"
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            + Add field
          </button>
          <div className="flex items-center gap-1">
            <select
              data-testid="manage-fields-preset-select"
              aria-label={t("codex.detail.presetPickerLabel")}
              value={presetGenre}
              onChange={(e) => setPresetGenre(e.target.value)}
              className="rounded-md border border-input bg-background px-1.5 py-1 text-xs"
            >
              <option value="">{t("codex.detail.presetBase")}</option>
              {PRESET_GENRES.map((genre) => (
                <option key={genre} value={genre}>
                  {genre}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="manage-fields-preset-apply"
              onClick={handlePresetPreview}
              disabled={presetBusy}
              className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {t("codex.detail.presetApply")}
            </button>
          </div>
          <button
            type="button"
            data-testid="manage-fields-cleanup-button"
            onClick={() => void handleCleanupClick()}
            disabled={cleanupBusy}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-50"
          >
            {t("codex.detail.deleteEmptyFields")}
          </button>
          <button
            type="button"
            data-testid="manage-fields-close-button-footer"
            onClick={onClose}
            className="ml-auto rounded px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            Close
          </button>
        </div>
      </AnimatedOverlay>

      {deletingDef && (
        <DeleteConfirmDialog
          definitionName={deletingDef.name}
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeletingDef(null)}
        />
      )}

      {presetPreview && (
        <PresetConfirmDialog
          toAdd={presetPreview.toAdd}
          toSkip={presetPreview.toSkip}
          onConfirm={() => void handleApplyPreset()}
          onCancel={() => setPresetPreview(null)}
        />
      )}

      {cleanupTargets && (
        <CleanupConfirmDialog
          targets={cleanupTargets}
          onConfirm={() => void handleCleanupConfirm()}
          onCancel={() => setCleanupTargets(null)}
        />
      )}
    </>
  );
}
