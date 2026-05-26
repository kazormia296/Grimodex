// @vitest-environment happy-dom
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _clearProvidersForTests,
  registerProvider,
} from "../providers/registry";
import { useCommandCenterStore } from "../store/commandCenterStore";
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
    supportsMode?: CommandCenterProvider["supportsMode"];
  } = {},
): CommandCenterProvider {
  return {
    id,
    order: options.order ?? 1,
    title: id,
    hideWhenEmpty: options.hideWhenEmpty ?? true,
    surfaces: ["bar", "panel"],
    supportsMode: options.supportsMode ?? ((m) => m === "search"),
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
  useCommandCenterStore.setState({
    open: false,
    mode: "search",
    query: "",
    parsedQuery: "",
    sections: [],
    selectedIndex: 0,
    focusRequest: 0,
  });
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

  it("parses input and writes mode/parsedQuery to store", () => {
    renderHook(() => useCommandCenterSearch());
    act(() => {
      useCommandCenterStore.getState().setQuery(">cmd hello");
    });
    const s = useCommandCenterStore.getState();
    expect(s.mode).toBe("command");
    expect(s.parsedQuery).toBe("cmd hello");
  });

  it("invokes provider.search with trimmed query after debounce and upserts section", async () => {
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

    renderHook(() => useCommandCenterSearch({ limit: 10 }));
    act(() => {
      useCommandCenterStore.getState().setQuery("邂逅");
    });
    // before debounce timer fires, search must not have been called
    expect(search).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toMatchObject({
      query: "邂逅",
      limit: 10,
      mode: "search",
    });

    const sections = useCommandCenterStore.getState().sections;
    expect(sections.map((s) => s.id)).toEqual(["lexical"]);
    expect(sections[0].items.map((i) => i.id)).toEqual(["x"]);
  });

  it("shows loading section immediately while debounce timer is pending", () => {
    registerProvider(makeProvider("lexical"));
    renderHook(() => useCommandCenterSearch());
    act(() => {
      useCommandCenterStore.getState().setQuery("x");
    });
    const s = useCommandCenterStore.getState();
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].state?.kind).toBe("loading");
  });

  it("discards stale responses when query changes mid-flight (generation gating)", async () => {
    let resolveFirst: ((v: CommandCenterSection) => void) | undefined;
    const search = vi.fn((ctx: ProviderSearchContext) => {
      if (ctx.query === "first") {
        return new Promise<CommandCenterSection>((res) => {
          resolveFirst = res;
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
    renderHook(() => useCommandCenterSearch());

    act(() => {
      useCommandCenterStore.getState().setQuery("first");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // change query before first resolves
    act(() => {
      useCommandCenterStore.getState().setQuery("second");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    // now resolve the stale first
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

    const sections = useCommandCenterStore.getState().sections;
    expect(sections[0].items.map((i) => i.id)).toEqual(["second"]);
  });

  it("clears all sections when query becomes empty", async () => {
    registerProvider(makeProvider("lexical"));
    renderHook(() => useCommandCenterSearch());
    act(() => {
      useCommandCenterStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(useCommandCenterStore.getState().sections).toHaveLength(1);

    act(() => {
      useCommandCenterStore.getState().setQuery("");
    });
    expect(useCommandCenterStore.getState().sections).toEqual([]);
  });

  it("skips re-invocation when (query, mode, limit) is unchanged (memoization)", async () => {
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
      ({ limit }: { limit: number }) => useCommandCenterSearch({ limit }),
      { initialProps: { limit: 10 } },
    );
    act(() => {
      useCommandCenterStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(1);

    // re-render with same limit and same query → should not re-invoke
    rerender({ limit: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(1);

    // change limit → should re-invoke
    rerender({ limit: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls[1][0]).toMatchObject({ limit: 50 });
  });

  it("cacheKeyExtras change busts memo only for that provider (not others)", async () => {
    // Semantic-style provider: cacheKeyExtras depends on an external toggle.
    // Lexical-style provider: no cacheKeyExtras.
    let semanticToggle = false;
    const lexicalSearch = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "lexical",
      title: "lexical",
      order: 1,
      items: [],
    }));
    const semanticSearchFn = vi.fn<
      (ctx: ProviderSearchContext) => Promise<CommandCenterSection>
    >(async () => ({
      id: "semantic",
      title: "semantic",
      order: 2,
      items: [],
    }));
    registerProvider(
      makeProvider("lexical", { search: lexicalSearch, hideWhenEmpty: false }),
    );
    registerProvider({
      ...makeProvider("semantic", {
        search: semanticSearchFn,
        hideWhenEmpty: false,
      }),
      order: 2,
      cacheKeyExtras: () => `t=${semanticToggle ? 1 : 0}`,
    });
    renderHook(() => useCommandCenterSearch({ limit: 10 }));
    act(() => {
      useCommandCenterStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(lexicalSearch).toHaveBeenCalledTimes(1);
    expect(semanticSearchFn).toHaveBeenCalledTimes(1);

    // Flip the semantic-only toggle. Since the effect re-runs (deps mocked here
    // via store setter), only the semantic provider's baseKey changes → only
    // semantic re-fires; lexical's memo stays hot.
    semanticToggle = true;
    act(() => {
      // descriptionMode を変えて effect 再評価をトリガする
      useCommandCenterStore.getState().setDescriptionMode(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(lexicalSearch).toHaveBeenCalledTimes(1);
    expect(semanticSearchFn).toHaveBeenCalledTimes(2);
  });

  it("superset memo: when limit decreases on same query, does NOT re-invoke", async () => {
    // Advisor verify scenario: panel open (limit 50) → close (limit 10) → open (50).
    // Single hook ownership + superset memoization should cause exactly 1 re-fetch
    // (the 10→50 case), and skip both subsequent toggles.
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
      ({ limit }: { limit: number }) => useCommandCenterSearch({ limit }),
      { initialProps: { limit: 10 } },
    );

    // Initial type with bar-only (limit 10)
    act(() => {
      useCommandCenterStore.getState().setQuery("邂逅");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(1);

    // Panel opens — limit goes 10 → 50. 50 > 10 → refetch.
    rerender({ limit: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(2);

    // Panel closes — limit goes 50 → 10. 10 ≤ 50 → skip (we already have 50 items).
    rerender({ limit: 10 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(2);

    // Panel opens again — 50 ≤ 50 → skip.
    rerender({ limit: 50 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(2);

    // Query change — base key changes, memo reset → refetch.
    act(() => {
      useCommandCenterStore.getState().setQuery("別の語");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(search).toHaveBeenCalledTimes(3);
  });

  it("removes sections of providers that no longer support current mode", async () => {
    registerProvider(makeProvider("lexical"));
    registerProvider(
      makeProvider("command-only", {
        order: 3,
        supportsMode: (m) => m === "command",
      }),
    );
    renderHook(() => useCommandCenterSearch());
    act(() => {
      useCommandCenterStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(useCommandCenterStore.getState().sections.map((s) => s.id)).toEqual([
      "lexical",
    ]);

    // switch to command mode → lexical drops out, command-only takes over
    act(() => {
      useCommandCenterStore.getState().setQuery(">cmd");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(
      useCommandCenterStore.getState().sections.map((s) => s.id),
    ).not.toContain("lexical");
  });

  it("writes error state when provider throws", async () => {
    registerProvider(
      makeProvider("lexical", {
        hideWhenEmpty: false,
        search: async () => {
          throw new Error("boom");
        },
      }),
    );
    renderHook(() => useCommandCenterSearch());
    act(() => {
      useCommandCenterStore.getState().setQuery("hello");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const sections = useCommandCenterStore.getState().sections;
    expect(sections[0].state).toEqual({ kind: "error", message: "boom" });
  });
});
