// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearProvidersForTests,
  registerProvider,
} from "../providers/registry";
import { usePanelStore } from "../store/commandCenterStore";
import type {
  CommandCenterProvider,
  CommandCenterSection,
  ProviderSearchContext,
} from "../providers/types";
import { useCommandCenterSearch } from "./useCommandCenterSearch";

function makeProvider(
  id: string,
  options: {
    order?: number;
    hideWhenEmpty?: boolean;
    search?: (ctx: ProviderSearchContext) => Promise<CommandCenterSection>;
  } = {},
): CommandCenterProvider {
  return {
    id,
    order: options.order ?? 1,
    title: id,
    hideWhenEmpty: options.hideWhenEmpty ?? true,
    search:
      options.search ??
      (async (ctx) => ({
        id,
        title: id,
        order: options.order ?? 1,
        items: [
          {
            id: `${id}:0`,
            kind: "lexical-scene",
            title: `${id} for "${ctx.query}"`,
            onSelect: () => {},
          },
        ],
      })),
  };
}

function resetStore() {
  usePanelStore.getState().reset();
  usePanelStore.getState().setDescriptionMode(false);
}

describe("useCommandCenterSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    _clearProvidersForTests();
  });

  it("parses search text and exclusion tokens into the panel store", () => {
    renderHook(() => useCommandCenterSearch(usePanelStore));
    act(() => {
      usePanelStore.getState().setQuery("chapter -rain");
    });

    expect(usePanelStore.getState()).toMatchObject({
      parsedQuery: "chapter",
      excludes: ["rain"],
    });
    expect(usePanelStore.getState()).not.toHaveProperty("mode");
  });

  it("invokes providers with the trimmed query after debounce", async () => {
    const search = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "lexical",
      title: "lexical",
      order: 1,
      items: [
        {
          id: "x",
          kind: "lexical-scene",
          title: "hit",
          onSelect: () => {},
        },
      ],
    }));
    registerProvider(makeProvider("lexical", { search }));
    renderHook(() => useCommandCenterSearch(usePanelStore, { limit: 10 }));

    act(() => {
      usePanelStore.getState().setQuery("邂逅");
    });
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({
      query: "邂逅",
      limit: 10,
    });
    expect(search.mock.calls[0][0]).not.toHaveProperty("mode");
    expect(usePanelStore.getState().sections[0].items[0].id).toBe("x");
  });

  it("shows a loading section while debounce is pending", () => {
    registerProvider(makeProvider("lexical"));
    renderHook(() => useCommandCenterSearch(usePanelStore));
    act(() => {
      usePanelStore.getState().setQuery("x");
    });

    expect(usePanelStore.getState().sections[0].state?.kind).toBe("loading");
  });

  it("discards stale responses when the query changes mid-flight", async () => {
    let resolveFirst: ((value: CommandCenterSection) => void) | undefined;
    const search = vi.fn((ctx: ProviderSearchContext) => {
      if (ctx.query === "first") {
        return new Promise<CommandCenterSection>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve({
        id: "lexical",
        title: "lexical",
        order: 1,
        items: [
          {
            id: "second",
            kind: "lexical-scene" as const,
            title: "second",
            onSelect: () => {},
          },
        ],
      });
    });
    registerProvider(makeProvider("lexical", { search }));
    renderHook(() => useCommandCenterSearch(usePanelStore));

    act(() => {
      usePanelStore.getState().setQuery("first");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      usePanelStore.getState().setQuery("second");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    act(() => {
      resolveFirst?.({
        id: "lexical",
        title: "lexical",
        order: 1,
        items: [
          {
            id: "first",
            kind: "lexical-scene",
            title: "first",
            onSelect: () => {},
          },
        ],
      });
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(
      usePanelStore.getState().sections[0].items.map((item) => item.id),
    ).toEqual(["second"]);
  });

  it("clears all sections when the query becomes empty", async () => {
    registerProvider(makeProvider("lexical"));
    renderHook(() => useCommandCenterSearch(usePanelStore));
    act(() => {
      usePanelStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(usePanelStore.getState().sections).toHaveLength(1);

    act(() => {
      usePanelStore.getState().setQuery("");
    });
    expect(usePanelStore.getState().sections).toEqual([]);
  });

  it("reuses a superset result when limit decreases for the same query", async () => {
    const search = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "lexical",
      title: "lexical",
      order: 1,
      items: [],
    }));
    registerProvider(makeProvider("lexical", { search, hideWhenEmpty: false }));
    const { rerender } = renderHook(
      ({ limit }: { limit: number }) =>
        useCommandCenterSearch(usePanelStore, { limit }),
      { initialProps: { limit: 10 } },
    );

    act(() => {
      usePanelStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ limit: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ limit: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ limit: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(search).toHaveBeenCalledTimes(2);
  });

  it("busts memo only for a provider whose cacheKeyExtras changed", async () => {
    let semanticToggle = false;
    const lexicalSearch = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "lexical",
      title: "lexical",
      order: 1,
      items: [],
    }));
    const semanticSearch = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "semantic",
      title: "semantic",
      order: 2,
      items: [],
    }));
    registerProvider(
      makeProvider("lexical", {
        search: lexicalSearch,
        hideWhenEmpty: false,
      }),
    );
    registerProvider({
      ...makeProvider("semantic", {
        order: 2,
        search: semanticSearch,
        hideWhenEmpty: false,
      }),
      cacheKeyExtras: () => `t=${semanticToggle ? 1 : 0}`,
    });
    renderHook(() => useCommandCenterSearch(usePanelStore, { limit: 10 }));
    act(() => {
      usePanelStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    semanticToggle = true;
    act(() => {
      usePanelStore.getState().setDescriptionMode(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(lexicalSearch).toHaveBeenCalledTimes(1);
    expect(semanticSearch).toHaveBeenCalledTimes(2);
  });

  it("writes an error state when a provider throws", async () => {
    registerProvider(
      makeProvider("lexical", {
        hideWhenEmpty: false,
        search: async () => {
          throw new Error("boom");
        },
      }),
    );
    renderHook(() => useCommandCenterSearch(usePanelStore));
    act(() => {
      usePanelStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(usePanelStore.getState().sections[0].state).toEqual({
      kind: "error",
      message: "boom",
    });
  });
});
