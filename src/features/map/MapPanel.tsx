import { ReactFlowProvider } from "@xyflow/react";
import { MapHeader } from "./MapHeader";
import { MapCanvas } from "./MapCanvas";

export function MapPanel() {
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <MapHeader />
      <div className="min-h-0 flex-1">
        <ReactFlowProvider>
          <MapCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  );
}
