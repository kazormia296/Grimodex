import { ReactFlowProvider } from "@xyflow/react";
import { MapHeader } from "./MapHeader";
import { MapCanvas } from "./MapCanvas";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";

export function MapPanel() {
  const trashDropRef = useDropTarget("map-panel", "map-panel");
  return (
    <div
      ref={trashDropRef}
      data-droptarget-id="map-panel"
      className="data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--background)",
      }}
    >
      <MapHeader />
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlowProvider>
          <MapCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
