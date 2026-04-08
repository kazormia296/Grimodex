import type { CodexContextMode } from "@/db/schema";
import { ContextModeSelector } from "./ContextModeSelector";
import { ExcludedAliasesField } from "./ExcludedAliasesField";

interface TrackingTabProps {
  contextMode: CodexContextMode;
  excludedAliases: string[];
  onContextModeChange: (mode: CodexContextMode) => void;
  onExcludedAliasesChange: (excluded: string[]) => void;
}

export function TrackingTab({
  contextMode,
  excludedAliases,
  onContextModeChange,
  onExcludedAliasesChange,
}: TrackingTabProps) {
  return (
    <div className="space-y-3">
      <ContextModeSelector value={contextMode} onChange={onContextModeChange} />
      <ExcludedAliasesField
        excludedAliases={excludedAliases}
        onChange={onExcludedAliasesChange}
      />
    </div>
  );
}
