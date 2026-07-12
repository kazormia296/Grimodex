import { describe, expect, it } from "vitest";
import { reduceTabState, type TabReducerState } from "./tabReducer";

const initial: TabReducerState = {
  tabs: [],
  activeTabId: null,
  secondaryTabs: [],
  secondaryActiveTabId: null,
  secondaryGroupOpen: false,
  activeGroupIndex: 0,
  splitDirection: "right",
};

describe("tabReducer", () => {
  it("replaces preview while preserving pinned tabs", () => {
    const first = reduceTabState(initial, {
      type: "preview/open",
      nodeId: "scene-a",
    });
    const second = reduceTabState(first, {
      type: "preview/open",
      nodeId: "scene-b",
    });

    expect(second.tabs.map((tab) => tab.nodeId)).toEqual(["scene-b"]);
    expect(second.tabs[0]?.isPreview).toBe(true);
  });

  it("keeps non-scene identity when opening a tab in the secondary group", () => {
    const codex = reduceTabState(initial, {
      type: "codex/open",
      entryId: "entry-1",
      phaseId: "phase-1",
    });
    const next = reduceTabState(codex, {
      type: "secondary/open",
      nodeId: "entry-1",
    });

    expect(next.secondaryTabs[0]).toMatchObject({
      nodeId: "entry-1",
      contentType: "codex",
    });
  });

  it("does not make dirty/focus state part of the reducer snapshot", () => {
    const next = reduceTabState(initial, {
      type: "pinned/open",
      nodeId: "scene-a",
    });
    expect(next).not.toHaveProperty("dirtyTabIds");
    expect(next).not.toHaveProperty("focusRequests");
  });
});
