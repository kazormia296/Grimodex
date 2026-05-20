import { memo } from "react";
import { STRIPE_SIZE } from "./layoutConstants";
import { CenterStripe } from "./CenterStripe";
import { CenterContent } from "./CenterContent";
import { useCenterHasStripe, useCenterSegments } from "./useCenterSegments";
import { useLayoutStore } from "./layoutStore";
import { isCenterBandVisible } from "./layoutStateUtils";

export const CenterWorkspace = memo(function CenterWorkspace() {
  const layout = useLayoutStore((s) => s.layout);
  const segments = useCenterSegments();
  const hasStripe = useCenterHasStripe();

  if (!isCenterBandVisible(layout)) return null;

  return (
    <div
      data-center-workspace
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
    >
      {hasStripe && (
        <div style={{ height: STRIPE_SIZE, flexShrink: 0 }}>
          <CenterStripe segments={segments} />
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <CenterContent />
      </div>
    </div>
  );
});
