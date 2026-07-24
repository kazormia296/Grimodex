import { beforeEach, describe, expect, it } from "vitest";
import { usePanelStore } from "./commandCenterStore";
import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

function item(id: string): CommandCenterItem {
  return { id, kind: "lexical-scene", title: id, onSelect: () => {} };
}

function lexicalSection(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "lexical", title: "Lexical", order: 1, items };
}

function semanticSection(items: CommandCenterItem[]): CommandCenterSection {
  return { id: "semantic", title: "Semantic", order: 2, items };
}

describe("usePanelStore", () => {
  beforeEach(() => {
    usePanelStore.getState().reset();
    usePanelStore.getState().setDescriptionMode(false);
  });

  it("updates the search query, parsed query, excludes, and description mode", () => {
    const state = usePanelStore.getState();
    state.setQuery("chapter -rain");
    state.setParsedQuery("chapter");
    state.setExcludes(["rain"]);
    state.setDescriptionMode(true);

    expect(usePanelStore.getState()).toMatchObject({
      query: "chapter -rain",
      parsedQuery: "chapter",
      excludes: ["rain"],
      descriptionMode: true,
    });
  });

  it("upsertSection replaces by id and sorts by provider order", () => {
    const { upsertSection } = usePanelStore.getState();
    upsertSection(semanticSection([item("s1")]), true);
    upsertSection(lexicalSection([item("l1")]), true);

    expect(usePanelStore.getState().sections.map((s) => s.id)).toEqual([
      "lexical",
      "semantic",
    ]);
  });

  it("removes an empty section when hideWhenEmpty is true", () => {
    const { upsertSection } = usePanelStore.getState();
    upsertSection(lexicalSection([item("l1")]), true);
    upsertSection(lexicalSection([]), true);

    expect(usePanelStore.getState().sections).toEqual([]);
  });

  it("keeps an empty section when hideWhenEmpty is false", () => {
    usePanelStore.getState().upsertSection(lexicalSection([]), false);

    expect(usePanelStore.getState().sections).toHaveLength(1);
    expect(usePanelStore.getState().sections[0].items).toEqual([]);
  });

  it("keeps loading and error states even when hideWhenEmpty is true", () => {
    const { upsertSection } = usePanelStore.getState();
    upsertSection(
      {
        ...lexicalSection([]),
        state: { kind: "loading" },
      },
      true,
    );
    expect(usePanelStore.getState().sections).toHaveLength(1);

    upsertSection(
      {
        ...lexicalSection([]),
        state: { kind: "error", message: "boom" },
      },
      true,
    );
    expect(usePanelStore.getState().sections).toHaveLength(1);
  });

  it("removeSection removes only the requested provider section", () => {
    const state = usePanelStore.getState();
    state.upsertSection(lexicalSection([item("l1")]), true);
    state.upsertSection(semanticSection([item("s1")]), true);
    state.removeSection("lexical");

    expect(usePanelStore.getState().sections.map((s) => s.id)).toEqual([
      "semantic",
    ]);
  });

  it("reset clears query parsing and results while preserving the preference", () => {
    const state = usePanelStore.getState();
    state.setQuery("chapter -rain");
    state.setParsedQuery("chapter");
    state.setExcludes(["rain"]);
    state.setDescriptionMode(true);
    state.upsertSection(lexicalSection([item("l1")]), true);
    state.reset();

    expect(usePanelStore.getState()).toMatchObject({
      query: "",
      parsedQuery: "",
      excludes: [],
      descriptionMode: true,
      sections: [],
    });
  });

  it("does not expose header-bar navigation or popover state", () => {
    const state = usePanelStore.getState() as unknown as Record<
      string,
      unknown
    >;
    expect(state).not.toHaveProperty("open");
    expect(state).not.toHaveProperty("mode");
    expect(state).not.toHaveProperty("selectedIndex");
    expect(state).not.toHaveProperty("focusRequest");
    expect(state).not.toHaveProperty("moveSelection");
    expect(state).not.toHaveProperty("executeSelected");
  });
});
