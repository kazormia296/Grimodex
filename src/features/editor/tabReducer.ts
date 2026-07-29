import type { GroupIndex, TabEntry } from "./tabStore";

export interface TabReducerState {
  tabs: TabEntry[];
  activeTabId: string | null;
  secondaryTabs: TabEntry[];
  secondaryActiveTabId: string | null;
  secondaryGroupOpen: boolean;
  activeGroupIndex: GroupIndex;
  splitDirection: "right" | "below";
}

export type TabAction =
  | { type: "preview/open"; nodeId: string }
  | { type: "pinned/open"; nodeId: string }
  | { type: "codex/open"; entryId: string; phaseId?: string | null }
  | { type: "snippet/open"; snippetId: string }
  | { type: "chronicle-event/open"; eventId: string; label?: string }
  | { type: "secondary/open"; nodeId: string; direction?: "right" | "below" };

function secondaryEntryFor(state: TabReducerState, nodeId: string): TabEntry {
  const source =
    state.tabs.find((tab) => tab.nodeId === nodeId) ??
    state.secondaryTabs.find((tab) => tab.nodeId === nodeId);
  return {
    nodeId,
    isPreview: false,
    contentType: source?.contentType ?? "scene",
    ...(source?.label !== undefined ? { label: source.label } : {}),
    ...(source?.overridePhaseId !== undefined
      ? { overridePhaseId: source.overridePhaseId }
      : {}),
  };
}

/** Pure tab identity/group transition. Guards and persistence live outside. */
export function reduceTabState(
  state: TabReducerState,
  action: TabAction,
): TabReducerState {
  switch (action.type) {
    case "preview/open": {
      const existing = state.tabs.find((tab) => tab.nodeId === action.nodeId);
      if (existing) {
        return {
          ...state,
          tabs: state.tabs.filter(
            (tab) => !tab.isPreview || tab.nodeId === action.nodeId,
          ),
          activeTabId: action.nodeId,
          activeGroupIndex: 0,
        };
      }
      const withoutPreview = state.tabs.filter((tab) => !tab.isPreview);
      const hadPreview = withoutPreview.length < state.tabs.length;
      return {
        ...state,
        tabs: [
          ...withoutPreview,
          {
            nodeId: action.nodeId,
            isPreview: true,
            contentType: "scene",
            animateIn: !hadPreview,
          },
        ],
        activeTabId: action.nodeId,
        activeGroupIndex: 0,
      };
    }
    case "pinned/open": {
      const existing = state.tabs.find((tab) => tab.nodeId === action.nodeId);
      if (existing) {
        return {
          ...state,
          tabs: existing.isPreview
            ? state.tabs.map((tab) =>
                tab.nodeId === action.nodeId
                  ? (() => {
                      const { animateIn: _animateIn, ...rest } = tab;
                      return { ...rest, isPreview: false };
                    })()
                  : tab,
              )
            : state.tabs,
          activeTabId: action.nodeId,
          activeGroupIndex: 0,
        };
      }
      return {
        ...state,
        tabs: [
          ...state.tabs,
          { nodeId: action.nodeId, isPreview: false, contentType: "scene" },
        ],
        activeTabId: action.nodeId,
        activeGroupIndex: 0,
      };
    }
    case "codex/open": {
      const existing = state.tabs.some((tab) => tab.nodeId === action.entryId);
      if (existing) {
        return {
          ...state,
          tabs: state.tabs.map((tab) =>
            tab.nodeId === action.entryId
              ? { ...tab, overridePhaseId: action.phaseId ?? null }
              : tab,
          ),
          activeTabId: action.entryId,
          activeGroupIndex: 0,
        };
      }
      return {
        ...state,
        tabs: [
          ...state.tabs.filter((tab) => !tab.isPreview),
          {
            nodeId: action.entryId,
            isPreview: false,
            contentType: "codex",
            overridePhaseId: action.phaseId ?? null,
          },
        ],
        activeTabId: action.entryId,
        activeGroupIndex: 0,
      };
    }
    case "snippet/open": {
      const existing = state.tabs.some(
        (tab) => tab.nodeId === action.snippetId,
      );
      return {
        ...state,
        tabs: existing
          ? state.tabs
          : [
              ...state.tabs.filter((tab) => !tab.isPreview),
              {
                nodeId: action.snippetId,
                isPreview: false,
                contentType: "snippet",
              },
            ],
        activeTabId: action.snippetId,
        activeGroupIndex: 0,
      };
    }
    case "chronicle-event/open": {
      const existing = state.tabs.some((tab) => tab.nodeId === action.eventId);
      return {
        ...state,
        tabs: existing
          ? state.tabs.map((tab) =>
              tab.nodeId === action.eventId
                ? { ...tab, label: action.label }
                : tab,
            )
          : [
              ...state.tabs.filter((tab) => !tab.isPreview),
              {
                nodeId: action.eventId,
                isPreview: false,
                contentType: "chronicle_event",
                label: action.label,
              },
            ],
        activeTabId: action.eventId,
        activeGroupIndex: 0,
      };
    }
    case "secondary/open": {
      const existing = state.secondaryTabs.some(
        (tab) => tab.nodeId === action.nodeId,
      );
      return {
        ...state,
        secondaryTabs: existing
          ? state.secondaryTabs
          : [...state.secondaryTabs, secondaryEntryFor(state, action.nodeId)],
        secondaryActiveTabId: action.nodeId,
        secondaryGroupOpen: true,
        activeGroupIndex: 1,
        ...(action.direction ? { splitDirection: action.direction } : {}),
      };
    }
  }
}
