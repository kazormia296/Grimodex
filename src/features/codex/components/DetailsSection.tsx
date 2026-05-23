import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Settings, Plus } from "lucide-react";
import { useAutoSave } from "@/hooks/useAutoSave";
import type { CodexEntry } from "../api";
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
import { ManageFieldsDialog } from "./ManageFieldsDialog";
import { FormFieldSkeletonList } from "@/components/ui/skeleton-patterns";

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

interface DetailFieldRowProps {
  entryId: string;
  definition: CodexDetailDefinition;
  currentValue: string;
  onToggleContext: (def: CodexDetailDefinition) => Promise<void>;
}

function DetailFieldRow({
  entryId,
  definition,
  currentValue,
  onToggleContext,
}: DetailFieldRowProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium">{definition.name}</label>
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
        <div
          data-testid={`detail-field-${definition.id}`}
          className="text-xs text-muted-foreground"
        >
          <input
            data-testid={`detail-field-ref-${definition.id}`}
            type="text"
            defaultValue={currentValue}
            onBlur={async (e) => {
              await upsertValue(entryId, definition.id, e.target.value);
            }}
            placeholder={t("codex.detail.entryIdPlaceholder")}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
        </div>
      )}
    </div>
  );
}

interface DetailsSectionProps {
  entry: CodexEntry;
}

export function DetailsSection({ entry }: DetailsSectionProps) {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<CodexDetailDefinition[]>([]);
  const [valuesMap, setValuesMap] = useState<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isManageOpen, setIsManageOpen] = useState(false);

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
            />
          ))}
        </div>
      )}

      <ManageFieldsDialog
        projectId={entry.projectId}
        typeSlug={entry.type}
        typeLabel={entry.type}
        open={isManageOpen}
        onClose={() => {
          setIsManageOpen(false);
          void load();
        }}
      />
    </div>
  );
}
