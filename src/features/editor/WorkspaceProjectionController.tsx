import { useEffect, useRef } from "react";

import {
  useLayoutStore,
  type LayoutViewportBaseline,
} from "@/features/layout/layoutStore";
import { cloneLayoutState } from "@/features/layout/layoutStateUtils";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";

interface WorkspaceProjectionControllerProps {
  phoneWorkspace: boolean;
}

export function WorkspaceProjectionController({
  phoneWorkspace,
}: WorkspaceProjectionControllerProps) {
  const phoneLayoutBaseline = useRef<LayoutViewportBaseline | null>(null);
  const layoutInitialized = useLayoutStore((state) => state.initialized);
  const { initializeLayout, restoreViewportBaseline } = useLayoutStore();

  useEffect(() => {
    void initializeLayout();
  }, [initializeLayout]);

  useEffect(() => {
    if (phoneWorkspace) {
      if (!layoutInitialized || phoneLayoutBaseline.current) return;
      const state = useLayoutStore.getState();
      phoneLayoutBaseline.current = {
        layout: cloneLayoutState(state.layout),
        activePresetId: state.activePresetId,
        hiddenStripePanels: new Set(state.hiddenStripePanels),
        maximizedPanelId: state.maximizedPanelId,
      };
      return;
    }

    useCompactNavigationStore.getState().reset();
    const baseline = phoneLayoutBaseline.current;
    if (!baseline) return;
    restoreViewportBaseline(baseline);
    phoneLayoutBaseline.current = null;
  }, [layoutInitialized, phoneWorkspace, restoreViewportBaseline]);

  return null;
}
