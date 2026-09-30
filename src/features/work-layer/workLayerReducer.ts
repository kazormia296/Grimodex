export type WorkLayerMode =
  | "ambient"
  | "tray-focus"
  | "tray-attention"
  | "tray-disposed"
  | "ledger"
  | "lens"
  | "portal"
  | "projection"
  | "change-review"
  | "batch"
  | "system-activity"
  | "system-blocked"
  | "inspect"
  | "resolved";

export interface WorkLayerNavigationState {
  readonly mode: WorkLayerMode;
  readonly history: readonly WorkLayerMode[];
  readonly selectedFindingId: string | null;
  readonly decisionLabel: string | null;
}

export type WorkLayerNavigationAction =
  | { readonly type: "open-focus" }
  | { readonly type: "open-attention" }
  | { readonly type: "open-disposed" }
  | { readonly type: "open-ledger" }
  | { readonly type: "open-active-work" }
  | { readonly type: "open-finding"; readonly findingId: string }
  | { readonly type: "select-finding"; readonly findingId: string }
  | { readonly type: "open-portal" }
  | { readonly type: "open-projection" }
  | { readonly type: "open-change-review" }
  | { readonly type: "open-batch" }
  | {
      readonly type: "open-system";
      readonly systemState: "running" | "blocked";
    }
  | { readonly type: "open-inspect" }
  | {
      readonly type: "resolve-preview";
      readonly findingId: string;
      readonly decisionLabel: string;
    }
  | { readonly type: "back" }
  | { readonly type: "close" };

export function createInitialWorkLayerNavigationState(): WorkLayerNavigationState {
  return {
    mode: "ambient",
    history: [],
    selectedFindingId: null,
    decisionLabel: null,
  };
}

function enterFromAmbient(mode: WorkLayerMode): WorkLayerNavigationState {
  return {
    mode,
    history: ["ambient"],
    selectedFindingId: null,
    decisionLabel: null,
  };
}

function pushMode(
  state: WorkLayerNavigationState,
  mode: WorkLayerMode,
): WorkLayerNavigationState {
  return {
    ...state,
    mode,
    history: [...state.history, state.mode],
    decisionLabel: null,
  };
}

export function reduceWorkLayerNavigation(
  state: WorkLayerNavigationState,
  action: WorkLayerNavigationAction,
): WorkLayerNavigationState {
  switch (action.type) {
    case "open-focus":
      return enterFromAmbient("tray-focus");
    case "open-attention":
      return enterFromAmbient("tray-attention");
    case "open-disposed":
      return pushMode(state, "tray-disposed");
    case "open-ledger":
      return {
        mode: "ledger",
        history: ["ambient", "tray-focus"],
        selectedFindingId: null,
        decisionLabel: null,
      };
    case "open-active-work":
      return enterFromAmbient("tray-focus");
    case "open-finding":
      return {
        ...pushMode(state, "lens"),
        selectedFindingId: action.findingId,
      };
    case "select-finding":
      return { ...state, selectedFindingId: action.findingId };
    case "open-portal":
      return pushMode(state, "portal");
    case "open-projection":
      return {
        ...pushMode(state, "projection"),
        selectedFindingId: state.selectedFindingId,
      };
    case "open-change-review":
      return pushMode(state, "change-review");
    case "open-batch":
      return pushMode(state, "batch");
    case "open-system":
      return enterFromAmbient(
        action.systemState === "blocked" ? "system-blocked" : "system-activity",
      );
    case "open-inspect":
      return pushMode(state, "inspect");
    case "resolve-preview":
      return {
        mode: "resolved",
        history: ["ambient"],
        selectedFindingId: action.findingId,
        decisionLabel: action.decisionLabel,
      };
    case "back": {
      if (state.mode === "projection") {
        return createInitialWorkLayerNavigationState();
      }
      const previous = state.history.at(-1);
      if (previous == null) return createInitialWorkLayerNavigationState();
      return {
        ...state,
        mode: previous,
        history: state.history.slice(0, -1),
        selectedFindingId:
          previous === "ambient" || previous.startsWith("tray-")
            ? null
            : state.selectedFindingId,
        decisionLabel: null,
      };
    }
    case "close":
      return createInitialWorkLayerNavigationState();
  }
}
