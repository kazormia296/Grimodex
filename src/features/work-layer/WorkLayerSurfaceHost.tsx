import { lazy, Suspense } from "react";

import { useWorkLayer } from "./WorkLayerContext";

const LazyWorkLayerSurface = lazy(() =>
  import("./WorkLayerSurface").then(({ WorkLayerSurface }) => ({
    default: WorkLayerSurface,
  })),
);

/**
 * Keep the review surface out of the startup graph until the provider has a
 * real Work Layer model. The provider and the lightweight WorkPulse remain
 * eager so that the context can load and expose the arrival affordance.
 */
export function WorkLayerSurfaceHost() {
  const workLayer = useWorkLayer();
  if (workLayer == null) return null;

  return (
    <Suspense fallback={null}>
      <LazyWorkLayerSurface />
    </Suspense>
  );
}
