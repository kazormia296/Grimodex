import type { Editor } from "@tiptap/react";
import { cn } from "@/lib/utils";
import { useFindScrollbarMarkers } from "./useFindScrollbarMarkers";

export { buildFindScrollbarMarkers } from "./findScrollbarMarkerGeometry";

interface FindScrollbarMarkersProps {
  editor: Editor | null;
  scrollContainerRef: React.MutableRefObject<HTMLDivElement | null>;
  enabled: boolean;
  verticalMode: boolean;
}

/** Non-interactive overview ruler for the active editor's find results. */
export function FindScrollbarMarkers({
  editor,
  scrollContainerRef,
  enabled,
  verticalMode,
}: FindScrollbarMarkersProps) {
  const markers = useFindScrollbarMarkers({
    editor,
    scrollContainerRef,
    enabled,
    verticalMode,
  });

  if (!enabled || markers.length === 0) return null;

  const horizontalRail = verticalMode;
  return (
    <div
      aria-hidden="true"
      data-find-scrollbar-markers=""
      data-orientation={horizontalRail ? "horizontal" : "vertical"}
      className={cn(
        "pointer-events-none absolute z-30 overflow-hidden",
        horizontalRail ? "inset-x-0 bottom-2 h-2" : "inset-y-0 right-2 w-2",
      )}
    >
      {markers.map((marker, index) => (
        <span
          key={`${marker.positionPercent}:${index}`}
          data-find-scrollbar-marker=""
          data-current={marker.current ? "true" : "false"}
          className={cn(
            "find-scrollbar-marker absolute block",
            marker.current && "find-scrollbar-marker-current",
            horizontalRail
              ? "bottom-0 h-1.5 w-0.5 translate-x-1/2 rounded-t-sm"
              : "right-0 h-0.5 w-1.5 -translate-y-1/2 rounded-l-sm",
          )}
          style={
            horizontalRail
              ? { right: `${marker.positionPercent}%` }
              : { top: `${marker.positionPercent}%` }
          }
        />
      ))}
    </div>
  );
}
