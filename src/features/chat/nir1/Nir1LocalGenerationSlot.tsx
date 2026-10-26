import { Suspense, lazy } from "react";
import { NIR1_LOCAL_GENERATION_UI_ENABLED } from "./nir1LocalGenerationAvailability";
import type { Nir1LocalGenerationPanelProps } from "./Nir1LocalGenerationPanel";

// The generation screen is a lazy chunk requested only while the constant is
// on (DR-DD1C-2). A chunk that fails to load draws nothing.
const Nir1LocalGenerationPanel = /* @__PURE__ */ lazy(() =>
  import("./Nir1LocalGenerationPanel").catch(() => ({
    default: () => null,
  })),
);

/**
 * The chat panel's mount point of the NIR-1 local generation screen (DD-1c).
 * While `NIR1_LOCAL_GENERATION_UI_ENABLED` is false it creates no element,
 * requests no chunk and calls no IPC.
 */
export function Nir1LocalGenerationSlot(props: Nir1LocalGenerationPanelProps) {
  return NIR1_LOCAL_GENERATION_UI_ENABLED ? (
    <Suspense fallback={null}>
      <Nir1LocalGenerationPanel {...props} />
    </Suspense>
  ) : null;
}
