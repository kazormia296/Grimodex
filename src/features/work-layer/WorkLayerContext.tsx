import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
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
    active && port?.kind !== "live" ? initialModel : null,
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
  const currentPort = useRef(port);
  const currentActive = useRef(active);
  currentPort.current = port;
  currentActive.current = active;

  useEffect(() => {
    if (!active) {
      setModel(null);
      setPreviewFindingSession(createPreviewFindingSessionState(null));
      return;
    }
    // A live port is the only source of a live model: `initialModel` is a
    // preview/test seam and never stands in for live data.
    if (initialModel != null && port?.kind !== "live") {
      setModel(initialModel);
      return;
    }
    if (port == null) {
      setModel(null);
      return;
    }

    let cancelled = false;
    if (port.kind === "live") {
      // A different work's counts must not survive into the new work.
      setModel((current) =>
        current != null && current.scopeId !== port.scopeKey ? null : current,
      );
    }
    void port
      .load({ reason: "mount" })
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

  useEffect(() => {
    if (!active || port?.subscribe == null) return;
    return port.subscribe((nextModel) => {
      if (
        currentActive.current &&
        currentPort.current === port &&
        nextModel.scopeId === port.scopeKey
      ) {
        setModel(nextModel);
      }
    });
  }, [active, port]);

  const navigationMode = navigationController.navigation.mode;
  const previousNavigationMode = useRef(navigationMode);
  useEffect(() => {
    const previous = previousNavigationMode.current;
    previousNavigationMode.current = navigationMode;
    if (
      !active ||
      port?.kind !== "live" ||
      previous !== "ambient" ||
      (navigationMode !== "tray-focus" && navigationMode !== "tray-attention")
    ) {
      return;
    }
    void port
      .load({ reason: "tray-open" })
      .then((nextModel) => {
        if (
          currentActive.current &&
          currentPort.current === port &&
          nextModel.scopeId === port.scopeKey
        ) {
          setModel(nextModel);
        }
      })
      .catch(() => {});
  }, [active, navigationMode, port]);

  const hasPendingArrival = (model?.attentionDelta ?? 0) > 0;
  const modelScopeId = model?.scopeId;
  const previewModel =
    model == null
      ? null
      : derivePreviewFindingModel(model, previewFindingSession);
  const isLive = port?.kind === "live";
  // Live counts never announce or highlight arrivals (ADR 014: a count
  // change must not notify, open a pane, or move focus).
  const arrivalSuppressed =
    isLive ||
    (hasPendingArrival &&
      (navigationController.navigation.mode !== "ambient" ||
        consumedArrivalScope === modelScopeId));
  // Hide synchronously, without waiting for the effect above, a model that no
  // longer has a source (the port went away) or that belongs to another work
  // than the live port's. Otherwise one frame of the old counts would render.
  const modelOrphaned = port == null && initialModel == null;
  const modelOutOfScope =
    port?.kind === "live" && model != null && port.scopeKey !== model.scopeId;
  const visibleModel =
    modelOrphaned || modelOutOfScope || previewModel == null
      ? null
      : arrivalSuppressed
        ? { ...previewModel, attentionDelta: 0 }
        : previewModel;

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
          provenance: isLive ? "live" : "preview",
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
    !isLive &&
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

export function useWorkLayerProvenance(): "preview" | "live" {
  return useContext(WorkLayerContext)?.provenance ?? "preview";
}
