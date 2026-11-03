import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isElectron } from "@/lib/tauri";
import {
  readScopeProjectDefault,
  type ScopeDefaultValue,
} from "@/lib/sceneScopeDefault";
import { describeScopeDefault } from "./describeDefault";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import type { ImportTarget } from "@/features/import/importTarget";
// Registers this feature's lazy strings (DR-SDEF-52).
import "./sceneScopeDefaultTranslations";

/**
 * The import screen's check "apply the default to the imported scenes"
 * (SDEF/1 R14, default OFF; DR-SDEF-31). It can be turned on only when the
 * import goes into the current project and that project has a default: a new
 * project made by an import has none (R12).
 */
export function ImportScopeDefaultOption({
  importTarget,
  checked,
  onChange,
  disabled = false,
}: {
  importTarget: ImportTarget;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const workspacePath = useWorkspaceStore((state) => state.activeWorkspacePath);
  const [value, setValue] = useState<ScopeDefaultValue | null>(null);
  const hasDefault = value?.state === "set";

  useEffect(() => {
    let live = true;
    setValue(null);
    if (!isElectron() || !workspacePath || importTarget !== "currentProject")
      return;
    readScopeProjectDefault(workspacePath, getCurrentProjectId())
      .then((current) => {
        if (live) setValue(current.default);
      })
      .catch(() => {
        // Unreadable: the check stays off.
      });
    return () => {
      live = false;
    };
  }, [workspacePath, importTarget]);

  const available = importTarget === "currentProject" && hasDefault;
  useEffect(() => {
    if (!available && checked) onChange(false);
  }, [available, checked, onChange]);

  if (!isElectron()) return null;
  return (
    <label className="flex shrink-0 items-start gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        data-testid="import-scene-scope-apply-default"
        checked={checked && available}
        disabled={disabled || !available}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="text-foreground">
          {t("import.sceneScopeApplyDefault")}
        </span>
        {available && value?.state === "set" && (
          <>
            <br />
            <span data-testid="import-scene-scope-default-value">
              {t("import.sceneScopeApplyValue", {
                value: describeScopeDefault(value.queryIdentity, t),
              })}
            </span>
          </>
        )}
        {!available && (
          <>
            <br />
            {t(
              importTarget === "newProject"
                ? "import.sceneScopeApplyNewProject"
                : "import.sceneScopeApplyNoDefault",
            )}
          </>
        )}
      </span>
    </label>
  );
}
