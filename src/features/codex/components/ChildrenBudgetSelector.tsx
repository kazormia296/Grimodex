import { BUDGET_LABELS } from "../childrenBudget";
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
  return (
    <div>
      <label className="mb-1 block text-xs font-medium">
        子エントリのコンテキスト量
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ChildrenBudgetPreset)}
        disabled={!hasChildren}
        title={!hasChildren ? "子エントリがありません" : undefined}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
      >
        {(Object.keys(BUDGET_LABELS) as ChildrenBudgetPreset[]).map(
          (preset) => (
            <option key={preset} value={preset}>
              {BUDGET_LABELS[preset]}
            </option>
          ),
        )}
      </select>
    </div>
  );
}
