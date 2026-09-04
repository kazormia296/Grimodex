import { useEffect, useRef } from "react";

import { useWorkLayer } from "./WorkLayerContext";
import {
  EXPECTED_PROTOTYPE_NAVIGATION,
  prototypeModeForNavigation,
  type WorkLayerPrototypeMode,
} from "./workLayerPrototype";

interface WorkLayerPrototypeRouterProps {
  readonly mode: WorkLayerPrototypeMode;
  readonly onModeChange: (mode: WorkLayerPrototypeMode) => void;
}

export function WorkLayerPrototypeRouter({
  mode,
  onModeChange,
}: WorkLayerPrototypeRouterProps) {
  const workLayer = useWorkLayer();
  const routedRef = useRef(false);
  const reachedTargetRef = useRef(
    EXPECTED_PROTOTYPE_NAVIGATION[mode] === "ambient",
  );

  useEffect(() => {
    if (workLayer == null || routedRef.current) return;
    routedRef.current = true;
    const findingId = workLayer.model.attention[0]?.id;
    const evidenceFindingId = workLayer.model.attention[1]?.id ?? findingId;

    switch (mode) {
      case "ambient":
      case "arrive":
        return;
      case "tray-focus":
        workLayer.openFocus();
        return;
      case "tray-attention":
      case "empty":
        workLayer.openAttention();
        return;
      case "ledger":
        workLayer.openLedger();
        return;
      case "lens":
      case "portal":
      case "inspect":
        if (findingId == null) return;
        workLayer.openAttention();
        workLayer.openFinding(findingId);
        if (mode === "portal") workLayer.openPortal();
        if (mode === "inspect") workLayer.openInspect();
        return;
      case "resolved":
        if (findingId != null) workLayer.selectFinding(findingId);
        workLayer.resolvePreview(
          findingId ?? "preview-finding",
          "preview-candidate",
          "アリス・レインへ Binding（UI Preview）",
        );
        return;
      case "projection":
      case "batch":
        workLayer.openProjection();
        if (mode === "batch") workLayer.openBatch();
        return;
      case "change-review":
        workLayer.openProjection();
        if (evidenceFindingId == null) return;
        workLayer.selectFinding(evidenceFindingId);
        workLayer.openChangeReview();
        return;
      case "system-activity":
      case "system-blocked":
        workLayer.openSystem();
        return;
      case "disposed":
        workLayer.openAttention();
        workLayer.openDisposed();
        return;
    }
  }, [mode, workLayer]);

  useEffect(() => {
    if (workLayer == null || !routedRef.current) return;
    const navigationMode = workLayer.navigation.mode;
    if (!reachedTargetRef.current) {
      if (navigationMode === EXPECTED_PROTOTYPE_NAVIGATION[mode]) {
        reachedTargetRef.current = true;
      }
      return;
    }
    if (mode === "change-review" && navigationMode === "resolved") {
      return;
    }
    if (
      mode === "batch" &&
      (navigationMode === "change-review" || navigationMode === "inspect")
    ) {
      return;
    }
    if (navigationMode !== EXPECTED_PROTOTYPE_NAVIGATION[mode]) {
      onModeChange(prototypeModeForNavigation(navigationMode));
    }
  }, [mode, onModeChange, workLayer]);

  return null;
}
