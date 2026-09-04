import type { WorkLayerModel, WorkLayerPreviewDisposition } from "./types";
import type { WorkLayerNavigationState } from "./workLayerReducer";

export interface WorkLayerContextValue {
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
  readonly disposePreview: (
    findingId: string,
    disposition: WorkLayerPreviewDisposition,
  ) => void;
  readonly back: () => void;
  readonly close: () => void;
}
