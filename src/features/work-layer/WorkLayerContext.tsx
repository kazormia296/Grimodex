import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  createPreviewFindingSessionState,
  derivePreviewFindingModel,
  recordPreviewFindingDisposition,
} from "./previewFindingSession";
import type { WorkLayerModel, WorkLayerPort } from "./types";
import { switchWorkLayerFocus } from "./switchWorkLayerFocus";
import { useWorkLayerNavigationController } from "./useWorkLayerNavigationController";
import type { WorkLayerContextValue } from "./workLayerContextTypes";
import { WorkPulseLiveRegion } from "./WorkPulseLiveRegion";

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
  const [previewFindingSession, setPreviewFindingSession] = useState(
    createPreviewFindingSessionState(null),
  );
  const navigationController = useWorkLayerNavigationController({
    enabled: active && model != null,
    scopeId: model?.scopeId ?? null,
    systemState: model?.system.state ?? "idle",
  });

  useEffect(() => {
    if (!active) {
      setModel(null);
      setPreviewFindingSession(createPreviewFindingSessionState(null));
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
  const previewModel =
    model == null
      ? null
      : derivePreviewFindingModel(model, previewFindingSession);
  const arrivalSuppressed =
    hasPendingArrival &&
    (navigationController.navigation.mode !== "ambient" ||
      consumedArrivalScope === modelScopeId);
  const visibleModel =
    previewModel != null && arrivalSuppressed
      ? { ...previewModel, attentionDelta: 0 }
      : previewModel != null
        ? previewModel
        : null;

  useEffect(() => {
    if (modelScopeId == null) return;
    setPreviewFindingSession((current) =>
      current.scopeId === modelScopeId
        ? current
        : createPreviewFindingSessionState(modelScopeId),
    );
  }, [modelScopeId]);

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
            if (
              visibleModel.attention.some((finding) => finding.id === findingId)
            ) {
              setPreviewFindingSession((current) =>
                recordPreviewFindingDisposition(
                  current,
                  visibleModel.scopeId,
                  findingId,
                  "resolved",
                ),
              );
            }
            navigationController.resolvePreview(findingId, decisionLabel);
          },
          disposePreview: (findingId, disposition) => {
            if (
              !visibleModel.attention.some(
                (finding) => finding.id === findingId,
              )
            ) {
              return;
            }
            setPreviewFindingSession((current) =>
              recordPreviewFindingDisposition(
                current,
                visibleModel.scopeId,
                findingId,
                disposition,
              ),
            );
            navigationController.openAttention();
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
