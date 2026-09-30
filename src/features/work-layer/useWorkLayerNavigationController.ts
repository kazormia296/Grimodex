import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";

import type { WorkLayerSystemState } from "./types";
import {
  createInitialWorkLayerNavigationState,
  reduceWorkLayerNavigation,
} from "./workLayerReducer";

interface NavigationControllerOptions {
  readonly enabled: boolean;
  readonly scopeId: string | null;
  readonly systemState: WorkLayerSystemState;
}

const WORK_LAYER_MODAL_SELECTOR = "[data-work-layer-modal-root]";
const ANIMATED_OVERLAY_SELECTOR = '[data-animated-overlay-root="true"]';
const SEMANTIC_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';

function escapeBelongsToForeignOverlay(event: KeyboardEvent): boolean {
  const eventTarget = event.target instanceof Element ? event.target : null;
  const activeElement =
    document.activeElement instanceof Element ? document.activeElement : null;
  const isForeign = (element: Element | null) => {
    if (element == null) return false;
    if (element.closest(ANIMATED_OVERLAY_SELECTOR) != null) return true;
    const semanticModal = element.closest(SEMANTIC_MODAL_SELECTOR);
    return (
      semanticModal != null &&
      semanticModal.closest(WORK_LAYER_MODAL_SELECTOR) == null
    );
  };

  if (isForeign(eventTarget) || isForeign(activeElement)) return true;

  return Array.from(
    document.querySelectorAll(
      `${ANIMATED_OVERLAY_SELECTOR}, ${SEMANTIC_MODAL_SELECTOR}`,
    ),
  ).some((overlay) => overlay.closest(WORK_LAYER_MODAL_SELECTOR) == null);
}

export function useWorkLayerNavigationController({
  enabled,
  scopeId,
  systemState,
}: NavigationControllerOptions) {
  const [navigation, dispatch] = useReducer(
    reduceWorkLayerNavigation,
    undefined,
    createInitialWorkLayerNavigationState,
  );
  const ambientOpenerRef = useRef<HTMLElement | null>(null);
  const nestedOpenerIdsRef = useRef<string[]>([]);
  const previousModeRef = useRef(navigation.mode);
  const previousScopeIdRef = useRef(scopeId);

  // A preview decision and its navigation receipt are meaningful only within
  // one workspace scope. Reset before paint when a new model scope arrives so
  // a receipt from the prior project is never displayed against it.
  useLayoutEffect(() => {
    if (previousScopeIdRef.current === scopeId) return;
    previousScopeIdRef.current = scopeId;
    ambientOpenerRef.current = null;
    nestedOpenerIdsRef.current = [];
    dispatch({ type: "close" });
  }, [scopeId]);

  const rememberAmbientOpener = useCallback(() => {
    ambientOpenerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  const rememberNestedOpener = useCallback(() => {
    const activeElement = document.activeElement;
    nestedOpenerIdsRef.current.push(
      activeElement instanceof HTMLElement ? activeElement.id : "",
    );
  }, []);

  const restoreNestedOpener = useCallback(() => {
    const openerId = nestedOpenerIdsRef.current.pop();
    if (openerId == null || openerId.length === 0) return;
    queueMicrotask(() =>
      document.getElementById(openerId)?.focus({ preventScroll: true }),
    );
  }, []);

  const back = useCallback(() => {
    const previous = navigation.history.at(-1);
    if (navigation.mode === "projection") {
      nestedOpenerIdsRef.current = [];
    } else if (previous != null && previous !== "ambient") {
      restoreNestedOpener();
    }
    dispatch({ type: "back" });
  }, [navigation.history, navigation.mode, restoreNestedOpener]);

  const close = useCallback(() => {
    nestedOpenerIdsRef.current = [];
    dispatch({ type: "close" });
  }, []);

  useEffect(() => {
    if (enabled) return;
    ambientOpenerRef.current = null;
    nestedOpenerIdsRef.current = [];
    dispatch({ type: "close" });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || navigation.mode === "ambient") return;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      if (escapeBelongsToForeignOverlay(event)) return;
      event.preventDefault();
      event.stopPropagation();
      back();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [back, enabled, navigation.mode]);

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = navigation.mode;
    if (
      !enabled ||
      previousMode === "ambient" ||
      navigation.mode !== "ambient"
    ) {
      return;
    }
    const opener = ambientOpenerRef.current;
    ambientOpenerRef.current = null;
    nestedOpenerIdsRef.current = [];
    queueMicrotask(() => opener?.focus({ preventScroll: true }));
  }, [enabled, navigation.mode]);

  const openAmbientDoor = useCallback(
    (type: "open-focus" | "open-attention") => {
      if (navigation.mode === "ambient") rememberAmbientOpener();
      nestedOpenerIdsRef.current = [];
      dispatch({ type });
    },
    [navigation.mode, rememberAmbientOpener],
  );

  const openNested = useCallback(
    (
      type:
        | "open-disposed"
        | "open-ledger"
        | "open-portal"
        | "open-change-review"
        | "open-batch"
        | "open-inspect",
    ) => {
      rememberNestedOpener();
      dispatch({ type });
    },
    [rememberNestedOpener],
  );

  return {
    navigation,
    openFocus: () => openAmbientDoor("open-focus"),
    openAttention: () => openAmbientDoor("open-attention"),
    openDisposed: () => openNested("open-disposed"),
    openLedger: () => openNested("open-ledger"),
    openActiveWork: () => {
      nestedOpenerIdsRef.current = [];
      dispatch({ type: "open-active-work" });
    },
    openFinding: (findingId: string) => {
      rememberNestedOpener();
      dispatch({ type: "open-finding", findingId });
    },
    openPortal: () => openNested("open-portal"),
    openProjection: () => {
      nestedOpenerIdsRef.current = [];
      dispatch({ type: "open-projection" });
    },
    openChangeReview: () => openNested("open-change-review"),
    openBatch: () => openNested("open-batch"),
    openSystem: () => {
      if (systemState === "idle") return;
      rememberAmbientOpener();
      nestedOpenerIdsRef.current = [];
      dispatch({ type: "open-system", systemState });
    },
    openInspect: () => openNested("open-inspect"),
    selectFinding: (findingId: string) =>
      dispatch({ type: "select-finding", findingId }),
    resolvePreview: (findingId: string, decisionLabel: string) => {
      nestedOpenerIdsRef.current = [];
      dispatch({ type: "resolve-preview", findingId, decisionLabel });
    },
    back,
    close,
  };
}
