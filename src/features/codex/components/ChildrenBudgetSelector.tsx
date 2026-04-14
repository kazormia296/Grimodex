import { useTranslation } from "react-i18next";
import { getBudgetLabels } from "../childrenBudget";
import type { ChildrenBudgetPreset } from "../childrenBudget";

interface ChildrenBudgetSelectorProps {
  value: ChildrenBudgetPreset;
  onChange: (preset: ChildrenBudgetPreset) => void;
  hasChildren: boolean;
}

export function ChildrenBudgetSelector({
  value,
  onChange,
  hasChildren,
}: ChildrenBudgetSelectorProps) {
  const { t } = useTranslation();
  const labels = getBudgetLabels();

  return (
    <div>
      <label className="mb-1 block text-xs font-medium">
        {t("codex.childrenBudget.label")}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ChildrenBudgetPreset)}
        disabled={!hasChildren}
        title={!hasChildren ? t("codex.childrenBudget.noChildren") : undefined}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {(Object.keys(labels) as ChildrenBudgetPreset[]).map((preset) => (
          <option key={preset} value={preset}>
            {labels[preset]}
          </option>
        ))}
      </select>
    </div>
  );
}
