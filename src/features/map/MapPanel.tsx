import { lazy, Suspense } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { MapHeader } from "./MapHeader";
import { MapCanvas } from "./MapCanvas";
import { useMapStore } from "./mapStore";

// three 系をギャラクシー初回表示まで起動バンドルから外す
const MapGalaxyView = lazy(() => import("./galaxy/MapGalaxyView"));

export function MapPanel() {
  const viewKind = useMapStore((s) => s.viewKind);
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <MapHeader />
      <div className="min-h-0 flex-1">
        {viewKind === "galaxy" ? (
          <Suspense fallback={null}>
            <MapGalaxyView />
          </Suspense>
        ) : (
          <ReactFlowProvider>
            <MapCanvas />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
