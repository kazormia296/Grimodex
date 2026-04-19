import { useTranslation } from "react-i18next";
import type { TagMappingAction } from "./importApi";
import type { CodexType } from "@/features/codex/typeApi";

interface Props {
  allTagNames: string[];
  tagTypeConfigs: Map<string, TagMappingAction>;
  existingTypes: CodexType[];
  onConfigChange: (tagName: string, action: TagMappingAction) => void;
  onSkip: () => void;
  onNext: () => void;
}

export function TagMappingSection({
  allTagNames,
  tagTypeConfigs,
  existingTypes,
  onConfigChange,
  onSkip,
  onNext,
}: Props) {
  const { t } = useTranslation();

  function handleSelect(tagName: string, value: string) {
    if (value === "__none__") {
      onConfigChange(tagName, { mode: "none" });
    } else if (value === "__new__") {
      onConfigChange(tagName, { mode: "new" });
    } else {
      onConfigChange(tagName, { mode: "existing", typeSlug: value });
    }
  }

  function selectValue(action: TagMappingAction): string {
    if (action.mode === "none") return "__none__";
    if (action.mode === "new") return "__new__";
    return action.typeSlug;
  }

  return (
    <>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("import.tagMappingTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("import.tagMappingSubtitle")}
        </p>
      </div>

      <div className="max-h-[45vh] overflow-y-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <tbody>
            {allTagNames.map((tagName) => {
              const action = tagTypeConfigs.get(tagName) ?? { mode: "none" };
              return (
                <tr
                  key={tagName}
                  className="border-b border-border/50 last:border-0"
                >
                  <td className="px-3 py-2 text-muted-foreground">{tagName}</td>
                  <td className="px-3 py-2">
                    <select
                      value={selectValue(action)}
                      onChange={(e) => handleSelect(tagName, e.target.value)}
                      className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      <option value="__none__">
                        {t("import.tagMappingNone")}
                      </option>
                      <option value="__new__">
                        {t("import.tagMappingNew")}
                      </option>
                      {existingTypes.length > 0 && (
                        <optgroup label="─────────────">
                          {existingTypes.map((type) => (
                            <option key={type.slug} value={type.slug}>
                              {t("import.tagMappingExisting", {
                                label: type.label,
                              })}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onSkip}
          className="rounded px-3 py-1.5 text-sm hover:bg-accent"
        >
          {t("import.tagMappingSkip")}
        </button>
        <button
          type="button"
          onClick={onNext}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
        >
          {t("import.tagMappingNext")}
        </button>
      </div>
    </>
  );
}
