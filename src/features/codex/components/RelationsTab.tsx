import type { CodexEntry } from "../api";
import type { ChildrenBudgetPreset } from "../childrenBudget";
import { getChildrenFromArray } from "../childrenBudget";
import { useCodexStore } from "../codexStore";
import { ChildrenBudgetSelector } from "./ChildrenBudgetSelector";
import { RelationSection } from "./RelationSection";
import { CodexTypedRelationsSection } from "./CodexTypedRelationsSection";

interface RelationsTabProps {
  entry: CodexEntry;
  childrenBudget: ChildrenBudgetPreset;
  onChildrenBudgetChange: (preset: ChildrenBudgetPreset) => void;
}

export function RelationsTab({
  entry,
  childrenBudget,
  onChildrenBudgetChange,
}: RelationsTabProps) {
  const entries = useCodexStore((s) => s.entries);
  const hasChildren = getChildrenFromArray(entry.id, entries).length > 0;

  return (
    <div className="space-y-3">
      {/* 階層（親子）— 親子関係と、子エントリの AI 文脈注入量をまとめる */}
      <div className="space-y-3">
        <RelationSection entry={entry} />
        <ChildrenBudgetSelector
          value={childrenBudget}
          onChange={onChildrenBudgetChange}
          hasChildren={hasChildren}
        />
      </div>
      {/* 関係（対人） */}
      <CodexTypedRelationsSection entry={entry} />
    </div>
  );
}
