import { useTranslation } from "react-i18next";
import type { TagMappingAction } from "./importApi";
import type { CodexType } from "@/features/codex/typeApi";

export interface EntryConflict {
  entryId: string;
  entryName: string;
  /** Tag names that each have a type mapping */
  conflictingTags: string[];
  selectedTag: string;
}

interface Props {
  conflicts: EntryConflict[];
  conflictResolutions: Map<string, string>;
  tagTypeConfigs: Map<string, TagMappingAction>;
  existingTypes: CodexType[];
  onResolutionChange: (entryId: string, tagName: string) => void;
  onBack: () => void;
  onImport: () => void;
}

export function ConflictResolutionSection({
  conflicts,
  conflictResolutions,
  tagTypeConfigs,
  existingTypes,
  onResolutionChange,
  onBack,
  onImport,
}: Props) {
  const { t } = useTranslation();

  function typeLabel(tagName: string): string {
    const action = tagTypeConfigs.get(tagName);
    if (!action || action.mode === "none") return tagName;
    if (action.mode === "new")
      return `${tagName} (${t("import.tagMappingNew")})`;
    const type = existingTypes.find((tp) => tp.slug === action.typeSlug);
    return type ? `${tagName} → ${type.label}` : tagName;
  }

  return (
    <>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("import.conflictTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("import.conflictSubtitle", { count: conflicts.length })}
        </p>
      </div>

      <div className="max-h-[45vh] overflow-y-auto space-y-3 rounded-md border border-border p-3">
        {conflicts.map((conflict) => {
          const selected =
            conflictResolutions.get(conflict.entryId) ??
            conflict.conflictingTags[0];
          return (
            <div key={conflict.entryId} className="space-y-1">
              <p className="text-xs font-medium">{conflict.entryName}</p>
              <div className="flex flex-wrap gap-2">
                {conflict.conflictingTags.map((tagName) => (
                  <label
                    key={tagName}
                    className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
                  >
                    <input
                      type="radio"
                      name={`conflict-${conflict.entryId}`}
                      value={tagName}
                      checked={selected === tagName}
                      onChange={() =>
                        onResolutionChange(conflict.entryId, tagName)
                      }
                      className="accent-primary"
                    />
                    {typeLabel(tagName)}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-3 py-1.5 text-sm hover:bg-accent"
        >
          {t("import.conflictBack")}
        </button>
        <button
          type="button"
          onClick={onImport}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
        >
          {t("import.conflictImport")}
        </button>
      </div>
    </>
  );
}
