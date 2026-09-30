import { disposeWorkLayerFinding } from "./disposeWorkLayerFinding";
import type {
  WorkLayerFindingView,
  WorkLayerModel,
  WorkLayerPreviewDisposition,
} from "./types";

/**
 * UI preview-only dispositions that remove a Finding from its active Attention
 * set. These do not persist a human decision to the NIR backend.
 */
export type PreviewFindingDisposition =
  | "resolved"
  | WorkLayerPreviewDisposition;

/**
 * A preview session is explicitly bounded to one Work Layer scope. Keeping
 * the scope with the map prevents a decision made in one project preview from
 * hiding a same-ID Finding after the provider receives another project model.
 */
export interface PreviewFindingSessionState {
  readonly scopeId: string | null;
  readonly dispositionByFindingId: ReadonlyMap<
    string,
    PreviewFindingDisposition
  >;
}

export function createPreviewFindingSessionState(
  scopeId: string | null,
): PreviewFindingSessionState {
  return { scopeId, dispositionByFindingId: new Map() };
}

export function recordPreviewFindingDisposition(
  state: PreviewFindingSessionState,
  scopeId: string,
  findingId: string,
  disposition: PreviewFindingDisposition,
): PreviewFindingSessionState {
  const dispositionByFindingId = new Map(
    state.scopeId === scopeId ? state.dispositionByFindingId : undefined,
  );
  dispositionByFindingId.set(findingId, disposition);
  return { scopeId, dispositionByFindingId };
}

export function deriveActivePreviewAttention(
  model: WorkLayerModel,
  state: PreviewFindingSessionState,
): readonly WorkLayerFindingView[] {
  if (state.scopeId !== model.scopeId) return model.attention;

  return model.attention.filter(
    (finding) => !state.dispositionByFindingId.has(finding.id),
  );
}

export function derivePreviewFindingModel(
  model: WorkLayerModel,
  state: PreviewFindingSessionState,
): WorkLayerModel {
  if (state.scopeId !== model.scopeId) return model;

  let previewModel = model;
  for (const [findingId, disposition] of state.dispositionByFindingId) {
    previewModel =
      disposition === "resolved"
        ? {
            ...previewModel,
            attention: previewModel.attention.filter(
              (finding) => finding.id !== findingId,
            ),
          }
        : disposeWorkLayerFinding(previewModel, findingId, disposition);
  }
  return previewModel;
}
