import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Settings, Plus, X, Layers, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useAutoSave } from "@/hooks/useAutoSave";
import { getCodexEntry, type CodexEntry } from "../api";
import { detailValueToPlainText } from "../detailCleanup";
import { usePhaseStore } from "../phaseStore";
import type {
  CodexDetailDefinition,
  DetailValueWithDefinition,
} from "../detailApi";
import {
  listDefinitionsByType,
  listValuesByEntry,
  upsertValue,
  updateDefinition,
} from "../detailApi";
import { CodexContentEditor } from "./CodexContentEditor";
import { PinEntryDialog } from "./PinEntryDialog";
import { ManageFieldsDialog } from "./ManageFieldsDialog";
import { FormFieldSkeletonList } from "@/components/ui/skeleton-patterns";
import { useProjectStore } from "@/features/project/projectStore";

interface TextFieldProps {
  definition: CodexDetailDefinition;
  initialValue: string;
  entryId: string;
}

function TextField({ definition, initialValue, entryId }: TextFieldProps) {
  const [currentValue, setCurrentValue] = useState(initialValue);

  const saveFn = useCallback(async () => {
    await upsertValue(entryId, definition.id, currentValue);
  }, [entryId, definition.id, currentValue]);

  const { schedule } = useAutoSave(saveFn, 2000);

  return (
    <div data-testid={`detail-field-${definition.id}`} className="space-y-1">
      <CodexContentEditor
        compact
        content={currentValue || "{}"}
        onContentChange={(val) => {
          setCurrentValue(val);
          schedule();
        }}
      />
    </div>
  );
}

interface DropdownFieldProps {
  definition: CodexDetailDefinition;
  initialValue: string;
  entryId: string;
}

function DropdownField({
  definition,
  initialValue,
  entryId,
}: DropdownFieldProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);

  let options: string[];
  try {
    const config = JSON.parse(definition.fieldConfig ?? "{}") as {
      options?: string[];
    };
    options = config.options ?? [];
  } catch {
    options = [];
  }

  const handleChange = async (newValue: string) => {
    setValue(newValue);
    await upsertValue(entryId, definition.id, newValue);
  };

  return (
    <div data-testid={`detail-field-${definition.id}`}>
      <select
        data-testid={`detail-field-dropdown-${definition.id}`}
        value={value}
        onChange={(e) => void handleChange(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      >
        <option value="">{t("codex.detail.selectPlaceholder")}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ReferenceFieldProps {
  definition: CodexDetailDefinition;
  initialValue: string;
  entryId: string;
  projectId: string;
}

function ReferenceField({
  definition,
  initialValue,
  entryId,
  projectId,
}: ReferenceFieldProps) {
  const { t } = useTranslation();
  const [refId, setRefId] = useState(initialValue);
  const [resolvedName, setResolvedName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  // 保存されているのは entry ID。表示用に名前を解決する。
  // 未解決時は上書きしない（選択直後の楽観表示を消さないため。
  // refId の変更経路は選択/クリアのみなので stale 化しない）
  useEffect(() => {
    if (!refId) {
      setResolvedName(null);
      return;
    }
    let cancelled = false;
    void getCodexEntry(projectId, refId).then((entry) => {
      if (!cancelled && entry) setResolvedName(entry.name);
    });
    return () => {
      cancelled = true;
    };
  }, [refId, projectId]);

  const handleSelect = async (selected: CodexEntry) => {
    // パレットの FTS5 検索は project スコープを持たないため、ここで弾く
    if (selected.projectId !== projectId) {
      toast.error(t("codex.detail.referenceCrossProject"));
      return;
    }
    setRefId(selected.id);
    setResolvedName(selected.name);
    setPickerOpen(false);
    await upsertValue(entryId, definition.id, selected.id);
  };

  const handleClear = async () => {
    setRefId("");
    setResolvedName(null);
    await upsertValue(entryId, definition.id, "");
  };

  return (
    <div
      ref={anchorRef}
      data-testid={`detail-field-${definition.id}`}
      className="flex items-center gap-1"
    >
      <button
        type="button"
        data-testid={`detail-field-ref-${definition.id}`}
        onClick={() => setPickerOpen(true)}
        className={`min-w-0 flex-1 truncate rounded-md border border-input bg-background px-2 py-1.5 text-left text-sm hover:bg-accent ${
          refId ? "" : "text-muted-foreground"
        }`}
      >
        {refId ? (resolvedName ?? refId) : t("codex.detail.selectReference")}
      </button>
      {refId && (
        <button
          type="button"
          data-testid={`detail-field-ref-clear-${definition.id}`}
          onClick={() => void handleClear()}
          className="rounded p-1 text-muted-foreground hover:bg-accent"
          title={t("common.delete")}
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <PinEntryDialog
        open={pickerOpen}
        anchorRef={anchorRef}
        tabs={["codex"]}
        selectionMode="single"
        selectedId={refId || null}
        title={definition.name}
        onSelect={(selected) => void handleSelect(selected)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

interface DetailFieldRowProps {
  entryId: string;
  definition: CodexDetailDefinition;
  currentValue: string;
  onToggleContext: (def: CodexDetailDefinition) => Promise<void>;
  /** フェーズプレビュー中の解決値（undefined = このフィールドに上書きなし） */
  previewValue?: string | null;
  /** プレビューモードか（previewValue undefined でも read-only 表示にする） */
  previewMode: boolean;
  /** アクティブフェーズ（非プレビュー時のみ。上書き編集の対象） */
  activePhase: { id: string; label: string } | null;
  /** activePhase におけるこのフィールドの上書き値（undefined = 上書きなし） */
  overrideValue?: string | null;
  onUpsertOverride: (definitionId: string, value: string | null) => void;
  onDeleteOverride: (definitionId: string) => void;
}

function parseDropdownOptions(fieldConfig: string | null): string[] {
  try {
    const config = JSON.parse(fieldConfig ?? "{}") as { options?: string[] };
    return config.options ?? [];
  } catch {
    return [];
  }
}

function DetailFieldRow({
  entryId,
  definition,
  currentValue,
  onToggleContext,
  previewValue,
  previewMode,
  activePhase,
  overrideValue,
  onUpsertOverride,
  onDeleteOverride,
}: DetailFieldRowProps) {
  const { t } = useTranslation();
  const basePlain = detailValueToPlainText(currentValue);
  const hasOverride = overrideValue !== undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">{definition.name}</label>
        <div className="flex items-center gap-0.5">
          {!previewMode && activePhase && !hasOverride && (
            <button
              type="button"
              data-testid={`detail-field-override-add-${definition.id}`}
              onClick={() => onUpsertOverride(definition.id, basePlain)}
              className="rounded p-0.5 text-xs text-muted-foreground hover:bg-accent"
              title={t("codex.detail.overrideForPhase", {
                label: activePhase.label,
              })}
            >
              <Layers className="h-3 w-3" />
            </button>
          )}
          {!previewMode && activePhase && hasOverride && (
            <button
              type="button"
              data-testid={`detail-field-override-remove-${definition.id}`}
              onClick={() => onDeleteOverride(definition.id)}
              className="rounded p-0.5 text-xs text-primary hover:bg-accent"
              title={t("codex.detail.overrideRemove")}
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            data-testid={`detail-include-context-${definition.id}`}
            onClick={() => void onToggleContext(definition)}
            className={`rounded p-0.5 text-xs ${
              definition.includeInContext === 1
                ? "text-primary"
                : "text-muted-foreground"
            }`}
            title={
              definition.includeInContext === 1
                ? t("codex.detail.aiContextEnabled")
                : t("codex.detail.aiContextDisabled")
            }
          >
            <Bot className="h-3 w-3" />
          </button>
        </div>
      </div>

      {previewMode ? (
        // フェーズプレビュー: 解決値（上書きなしは base）を読み取り専用表示
        <div
          data-testid={`detail-field-preview-${definition.id}`}
          className={
            previewValue !== undefined ? "border-l-2 border-primary pl-2" : ""
          }
        >
          <p className="rounded-md border border-input bg-background px-2 py-1.5 text-sm">
            {(previewValue !== undefined
              ? detailValueToPlainText(previewValue)
              : basePlain) || (
              <span className="text-muted-foreground">
                {t("codex.detail.empty")}
              </span>
            )}
          </p>
          {previewValue !== undefined && basePlain && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Base: {basePlain}
            </p>
          )}
        </div>
      ) : hasOverride && activePhase ? (
        // アクティブフェーズの上書きを編集（base には触れない）
        <div className="border-l-2 border-primary pl-2">
          {definition.fieldType === "dropdown" ? (
            <select
              data-testid={`detail-field-override-select-${definition.id}`}
              value={overrideValue ?? ""}
              onChange={(e) => onUpsertOverride(definition.id, e.target.value)}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            >
              <option value="">{t("codex.detail.selectPlaceholder")}</option>
              {parseDropdownOptions(definition.fieldConfig).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              data-testid={`detail-field-override-input-${definition.id}`}
              defaultValue={overrideValue ?? ""}
              onBlur={(e) => {
                if (e.target.value !== (overrideValue ?? "")) {
                  onUpsertOverride(definition.id, e.target.value);
                }
              }}
              className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
            />
          )}
          {basePlain && (
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Base: {basePlain}
            </p>
          )}
        </div>
      ) : (
        <>
          {definition.fieldType === "text" && (
            <TextField
              definition={definition}
              initialValue={currentValue}
              entryId={entryId}
            />
          )}
          {definition.fieldType === "dropdown" && (
            <DropdownField
              definition={definition}
              initialValue={currentValue}
              entryId={entryId}
            />
          )}
          {definition.fieldType === "codex_reference" && (
            <ReferenceField
              definition={definition}
              initialValue={currentValue}
              entryId={entryId}
              projectId={definition.projectId}
            />
          )}
        </>
      )}
    </div>
  );
}

interface DetailsSectionProps {
  entry: CodexEntry;
  /** アクティブフェーズ（DetailsTab から。上書き編集の対象） */
  activePhase?: { id: string; label: string } | null;
  /** フェーズプレビュー中の解決済み detail 値（null = プレビューでない） */
  previewDetailValues?: Map<string, string | null> | null;
}

export function DetailsSection({
  entry,
  activePhase = null,
  previewDetailValues = null,
}: DetailsSectionProps) {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<CodexDetailDefinition[]>([]);
  const [valuesMap, setValuesMap] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isManageOpen, setIsManageOpen] = useState(false);
  const projectGenre = useProjectStore(
    (s) => s.projects.find((p) => p.id === entry.projectId)?.genre ?? null,
  );
  const previewMode = previewDetailValues != null;
  const phaseOverrides = usePhaseStore((s) =>
    activePhase ? s.detailOverrides[activePhase.id] : undefined,
  );
  const upsertDetailOverride = usePhaseStore((s) => s.upsertDetailOverride);
  const deleteDetailOverride = usePhaseStore((s) => s.deleteDetailOverride);

  const overrideValueFor = (
    definitionId: string,
  ): string | null | undefined => {
    const override = phaseOverrides?.find(
      (o) => o.definitionId === definitionId,
    );
    return override ? (override.value ?? null) : undefined;
  };

  const load = useCallback(async () => {
    setIsLoading(true);
    const [defs, vals] = await Promise.all([
      listDefinitionsByType(entry.projectId, entry.type),
      listValuesByEntry(entry.id),
    ]);
    setDefinitions(defs);
    const map = new Map<string, string>();
    vals.forEach((v: DetailValueWithDefinition) => {
      map.set(v.value.definitionId, v.value.value ?? "");
    });
    setValuesMap(map);
    setIsLoading(false);
  }, [entry.id, entry.projectId, entry.type]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggleContext = async (def: CodexDetailDefinition) => {
    const newVal = def.includeInContext === 1 ? 0 : 1;
    await updateDefinition(def.id, { includeInContext: newVal });
    setDefinitions((prev) =>
      prev.map((d) =>
        d.id === def.id ? { ...d, includeInContext: newVal } : d,
      ),
    );
  };

  return (
    <div className="space-y-3">
      <div
        data-testid="details-section-header"
        className="flex items-center justify-between"
      >
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("codex.detail.customDetailsTitle")}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="details-add-field-button"
            onClick={() => setIsManageOpen(true)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            title={t("codex.detail.addField")}
          >
            <Plus className="h-3 w-3" />
            {t("codex.detail.addField")}
          </button>
          <button
            type="button"
            data-testid="details-manage-button"
            onClick={() => setIsManageOpen(true)}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
            title={t("codex.detail.manageFields")}
          >
            <Settings className="h-3 w-3" />
          </button>
        </div>
      </div>

      {isLoading ? (
        <FormFieldSkeletonList testId="details-section-loading" />
      ) : definitions.length === 0 ? (
        <p
          data-testid="details-section-empty"
          className="text-xs text-muted-foreground"
        >
          {t("codex.detail.noFields")}
        </p>
      ) : (
        <div className="space-y-3">
          {definitions.map((def) => (
            <DetailFieldRow
              key={def.id}
              entryId={entry.id}
              definition={def}
              currentValue={valuesMap.get(def.id) ?? ""}
              onToggleContext={handleToggleContext}
              previewMode={previewMode}
              previewValue={
                previewMode && previewDetailValues.has(def.id)
                  ? previewDetailValues.get(def.id)
                  : undefined
              }
              activePhase={previewMode ? null : activePhase}
              overrideValue={previewMode ? undefined : overrideValueFor(def.id)}
              onUpsertOverride={(definitionId, value) => {
                if (!activePhase) return;
                void upsertDetailOverride(activePhase.id, definitionId, value);
              }}
              onDeleteOverride={(definitionId) => {
                if (!activePhase) return;
                void deleteDetailOverride(activePhase.id, definitionId);
              }}
            />
          ))}
        </div>
      )}

      <ManageFieldsDialog
        projectId={entry.projectId}
        typeSlug={entry.type}
        typeLabel={entry.type}
        projectGenre={projectGenre}
        open={isManageOpen}
        onClose={() => {
          setIsManageOpen(false);
          void load();
        }}
      />
    </div>
  );
}
