import type { CodexContextMode } from "@/db/schema";
import { ContextModeSelector } from "./ContextModeSelector";
import { ExcludedAliasesField } from "./ExcludedAliasesField";
import { ReadingsField } from "./ReadingsField";
import type { ReadingMap } from "../reading";

interface TrackingTabProps {
  contextMode: CodexContextMode;
  excludedAliases: string[];
  /** 読み対象の表記一覧 = [name, ...aliases]。 */
  surfaces: string[];
  readings: ReadingMap;
  onContextModeChange: (mode: CodexContextMode) => void;
  onExcludedAliasesChange: (excluded: string[]) => void;
  onReadingsChange: (next: ReadingMap) => void;
  onEstimateReadings: () => void;
  estimatingReadings: boolean;
}

export function TrackingTab({
  contextMode,
  excludedAliases,
  surfaces,
  readings,
  onContextModeChange,
  onExcludedAliasesChange,
  onReadingsChange,
  onEstimateReadings,
  estimatingReadings,
}: TrackingTabProps) {
  return (
    <div className="space-y-3">
      <ContextModeSelector value={contextMode} onChange={onContextModeChange} />
      <ReadingsField
        surfaces={surfaces}
        readings={readings}
        onChange={onReadingsChange}
        onEstimate={onEstimateReadings}
        estimating={estimatingReadings}
      />
      <ExcludedAliasesField
        excludedAliases={excludedAliases}
        onChange={onExcludedAliasesChange}
      />
    </div>
  );
}
