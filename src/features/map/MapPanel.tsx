import { ReactFlowProvider } from "@xyflow/react";
import { MapHeader } from "./MapHeader";
import { MapCanvas } from "./MapCanvas";

export function MapPanel() {
  return (
    <div
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
