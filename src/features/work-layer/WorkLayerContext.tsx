import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import type { WorkLayerModel, WorkLayerPort } from "./types";
import { switchWorkLayerFocus } from "./switchWorkLayerFocus";
import { useWorkLayerNavigationController } from "./useWorkLayerNavigationController";
import { WorkPulseLiveRegion } from "./WorkPulseLiveRegion";
import type { WorkLayerNavigationState } from "./workLayerReducer";

interface WorkLayerContextValue {
  readonly model: WorkLayerModel;
  readonly navigation: WorkLayerNavigationState;
  readonly openFocus: () => void;
  readonly openAttention: () => void;
  readonly openDisposed: () => void;
  readonly openLedger: () => void;
  readonly openActiveWork: () => void;
  readonly openFinding: (findingId: string) => void;
  readonly openPortal: () => void;
  readonly openProjection: () => void;
  readonly openChangeReview: () => void;
  readonly openBatch: () => void;
  readonly openSystem: () => void;
  readonly openInspect: () => void;
  readonly switchFocusPreview: (targetId: string) => void;
  readonly selectFinding: (findingId: string) => void;
  readonly resolvePreview: (
    findingId: string,
    candidateId: string,
    decisionLabel: string,
  ) => void;
  readonly back: () => void;
  readonly close: () => void;
}

const WorkLayerContext = createContext<WorkLayerContextValue | null>(null);

interface WorkLayerProviderProps {
  readonly children: ReactNode;
  readonly active?: boolean;
  readonly initialModel?: WorkLayerModel | null;
  readonly port?: WorkLayerPort | null;
  readonly onPreviewDecision?: (findingId: string, candidateId: string) => void;
}

export function WorkLayerProvider({
  children,
  active = true,
  initialModel = null,
  port = null,
  onPreviewDecision,
}: WorkLayerProviderProps) {
  const [model, setModel] = useState<WorkLayerModel | null>(
    active ? initialModel : null,
  );
  const [consumedArrivalScope, setConsumedArrivalScope] = useState<
    string | null
  >(null);
  const navigationController = useWorkLayerNavigationController({
    enabled: active && model != null,
    systemState: model?.system.state ?? "idle",
  });

  useEffect(() => {
    if (!active) {
      setModel(null);
      return;
    }
    if (initialModel != null) {
      setModel(initialModel);
      return;
    }
    if (port == null) {
      setModel(null);
      return;
    }

    let cancelled = false;
    void port
      .load()
      .then((nextModel) => {
        if (!cancelled) setModel(nextModel);
      })
      .catch(() => {
        if (!cancelled) setModel(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, initialModel, port]);

  const hasPendingArrival = (model?.attentionDelta ?? 0) > 0;
  const modelScopeId = model?.scopeId;
  const arrivalSuppressed =
    hasPendingArrival &&
    (navigationController.navigation.mode !== "ambient" ||
      consumedArrivalScope === modelScopeId);
  const visibleModel =
    model != null && arrivalSuppressed
      ? { ...model, attentionDelta: 0 }
      : model;

  useEffect(() => {
    if (
      modelScopeId == null ||
      !hasPendingArrival ||
      navigationController.navigation.mode === "ambient"
    ) {
      return;
    }
    setConsumedArrivalScope(modelScopeId);
  }, [hasPendingArrival, modelScopeId, navigationController.navigation.mode]);

  useEffect(() => {
    if (!hasPendingArrival) setConsumedArrivalScope(null);
  }, [hasPendingArrival]);

  const value: WorkLayerContextValue | null =
    !active || visibleModel == null
      ? null
      : {
          model: visibleModel,
          ...navigationController,
          switchFocusPreview: (targetId) => {
            setModel((current) =>
              current == null
                ? current
                : switchWorkLayerFocus(current, targetId),
            );
            navigationController.openFocus();
          },
          resolvePreview: (findingId, candidateId, decisionLabel) => {
            onPreviewDecision?.(findingId, candidateId);
            navigationController.resolvePreview(findingId, decisionLabel);
          },
        };
  const resolutionDelta =
    navigationController.navigation.mode === "resolved" &&
    (model?.attention.length ?? 0) > 0
      ? -1
      : 0;

  return (
    <WorkLayerContext.Provider value={value}>
      {active && (model != null || port != null) && (
        <WorkPulseLiveRegion
          attentionDelta={visibleModel?.attentionDelta ?? 0}
          resolutionDelta={resolutionDelta}
        />
      )}
      {children}
    </WorkLayerContext.Provider>
  );
}

export function useWorkLayer(): WorkLayerContextValue | null {
  return useContext(WorkLayerContext);
}
