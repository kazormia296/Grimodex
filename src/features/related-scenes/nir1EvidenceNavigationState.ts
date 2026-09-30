import {
  documentKeyFromBinding,
  encodeDocumentKey,
  type EncodedDocumentKey,
} from "@/features/editor/document/documentKey";
import type { SaveSnapshot } from "@/features/editor/document/mutationGate";

export interface Nir1EvidenceOrigin {
  readonly workspacePath: string;
  readonly openRevision: number;
  readonly projectId: string;
  readonly querySceneId: string;
  readonly queryGeneration: number;
}

export interface Nir1EvidenceNavigationRequest {
  readonly requestId: number;
  readonly origin: Nir1EvidenceOrigin;
  readonly targetSceneId: string;
}

export interface Nir1EvidenceNavigation extends Nir1EvidenceNavigationRequest {
  readonly bindingKey: string;
}

interface PendingNavigation {
  request: Nir1EvidenceNavigationRequest;
  bindingKey: string | null;
  accepted: boolean;
  targetObserved: boolean;
}

/**
 * Session-local race coordination only. `qualify` must receive the opaque key
 * from successful backend click validation; this state grants no authority.
 */
export function createNir1EvidenceNavigationState() {
  let generation = 0;
  let pending: PendingNavigation | null = null;
  const matches = (request: Nir1EvidenceNavigationRequest) =>
    pending?.request === request;

  function observeContext(context: Nir1EvidenceOrigin): void {
    if (!pending) return;
    const { origin, targetSceneId } = pending.request;
    const sameOrigin =
      origin.workspacePath === context.workspacePath &&
      origin.openRevision === context.openRevision &&
      origin.projectId === context.projectId &&
      origin.queryGeneration === context.queryGeneration;
    const atTarget = pending.accepted && context.querySceneId === targetSceneId;
    const beforeTransition =
      !pending.targetObserved && context.querySceneId === origin.querySceneId;
    if (!sameOrigin || (!atTarget && !beforeTransition)) {
      pending = null;
      return;
    }
    if (atTarget) pending.targetObserved = true;
  }

  return {
    begin(
      origin: Nir1EvidenceOrigin,
      targetSceneId: string,
    ): Nir1EvidenceNavigationRequest {
      const request = Object.freeze({
        requestId: ++generation,
        origin: Object.freeze({ ...origin }),
        targetSceneId,
      });
      pending = {
        request,
        bindingKey: null,
        accepted: false,
        targetObserved: false,
      };
      return request;
    },
    qualify(
      request: Nir1EvidenceNavigationRequest,
      bindingKey: string,
    ): boolean {
      if (
        !matches(request) ||
        !pending ||
        pending.bindingKey !== null ||
        bindingKey.length === 0
      )
        return false;
      pending.bindingKey = bindingKey;
      return true;
    },
    navigationAccepted(request: Nir1EvidenceNavigationRequest): boolean {
      if (!matches(request) || !pending?.bindingKey || pending.accepted)
        return false;
      pending.accepted = true;
      return true;
    },
    navigationBlocked(request: Nir1EvidenceNavigationRequest): void {
      if (matches(request)) pending = null;
    },
    observeContext,
    invalidate(): void {
      pending = null;
    },
    consume(context: Nir1EvidenceOrigin): Nir1EvidenceNavigation | null {
      observeContext(context);
      if (!pending?.accepted || !pending.bindingKey || !pending.targetObserved)
        return null;
      const navigation = Object.freeze({
        ...pending.request,
        bindingKey: pending.bindingKey,
      });
      pending = null;
      return navigation;
    },
  };
}

export interface Nir1EvidenceEditorState {
  readonly editor: object;
  readonly documentKey: EncodedDocumentKey;
  readonly loadToken: unknown;
  readonly saveSnapshot: SaveSnapshot | null;
  readonly isDirty: boolean;
}

export interface Nir1EvidenceEditorCapture {
  readonly editor: object;
  readonly documentKey: EncodedDocumentKey;
  readonly loadToken: unknown;
  readonly binding: SaveSnapshot["binding"];
  readonly editGeneration: number;
}

/** Capture immediately before awaiting qualification or projecting Evidence. */
export function captureNir1EvidenceEditor(
  state: Nir1EvidenceEditorState,
): Nir1EvidenceEditorCapture | null {
  if (state.isDirty || !state.saveSnapshot || state.loadToken == null)
    return null;
  const { binding, editGeneration } = state.saveSnapshot;
  if (state.documentKey !== encodeDocumentKey(documentKeyFromBinding(binding)))
    return null;
  return Object.freeze({
    editor: state.editor,
    documentKey: state.documentKey,
    loadToken: state.loadToken,
    binding,
    editGeneration,
  });
}

/** Must run synchronously immediately before setting selection, with no await. */
export function isNir1EvidenceEditorCurrent(
  captured: Nir1EvidenceEditorCapture | null,
  current: Nir1EvidenceEditorState,
): boolean {
  if (!captured || current.isDirty || !current.saveSnapshot) return false;
  return (
    captured.editor === current.editor &&
    captured.documentKey === current.documentKey &&
    captured.loadToken === current.loadToken &&
    captured.binding === current.saveSnapshot.binding &&
    captured.editGeneration === current.saveSnapshot.editGeneration
  );
}
