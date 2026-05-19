import { beforeEach, describe, expect, it, vi } from "vitest";
import { lexicalSearchProvider } from "./lexicalSearchProvider";
import type { ProviderSearchContext } from "./types";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(),
  },
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: vi.fn(),
  },
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: {
    getState: vi.fn(),
  },
}));

import { invoke } from "@/lib/tauri";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLayoutStore } from "@/features/layout/layoutStore";

function makeContext(
  overrides: Partial<ProviderSearchContext> = {},
): ProviderSearchContext {
  return {
    query: "邂逅",
    signal: new AbortController().signal,
    limit: 10,
    mode: "search",
    generation: 1,
    ...overrides,
  };
}

describe("lexicalSearchProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supports only search mode", () => {
    expect(lexicalSearchProvider.supportsMode("search")).toBe(true);
    expect(lexicalSearchProvider.supportsMode("command")).toBe(false);
  });

  it("returns an empty section without invoking fts_search when query is whitespace-only", async () => {
    const section = await lexicalSearchProvider.search(
      makeContext({ query: "   " }),
    );
    expect(section.items).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes fts_search with trimmed query and ctx.limit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await lexicalSearchProvider.search(
      makeContext({ query: "  hello  ", limit: 25 }),
    );
    expect(invoke).toHaveBeenCalledWith("fts_search", {
      projectId: "default-project",
      query: "hello",
      scope: "all",
      limit: 25,
    });
  });

  it("maps results to CommandCenterItem with correct kind/badge/id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([
      { sourceType: "scene", id: "s1", title: "第3章", excerpt: "雨が..." },
      { sourceType: "codex", id: "c1", title: "主人公", excerpt: "" },
      { sourceType: "snippet", id: "n1", title: "", excerpt: "雷鳴" },
    ]);
    const section = await lexicalSearchProvider.search(makeContext());
    expect(section.items).toHaveLength(3);
    expect(section.items[0]).toMatchObject({
      id: "lexical-scene:s1",
      kind: "lexical-scene",
      title: "第3章",
      subtitle: "雨が...",
      badge: { label: "Scene", tone: "scene" },
    });
    expect(section.items[1]).toMatchObject({
      id: "lexical-codex:c1",
      kind: "lexical-codex",
      badge: { tone: "codex" },
    });
    expect(section.items[1].subtitle).toBeUndefined();
    expect(section.items[2]).toMatchObject({
      kind: "lexical-snippet",
      badge: { tone: "snippet" },
    });
    expect(section.items[2].title).not.toBe(""); // fallback applied
  });

  it("onSelect (scene) calls setActiveScene + showPanel('editor')", async () => {
    const setActiveScene = vi.fn();
    const showPanel = vi.fn();
    vi.mocked(useTreeStore.getState).mockReturnValue({
      setActiveScene,
    } as never);
    vi.mocked(useLayoutStore.getState).mockReturnValue({ showPanel } as never);
    vi.mocked(invoke).mockResolvedValueOnce([
      { sourceType: "scene", id: "scene-1", title: "X", excerpt: "" },
    ]);
    const section = await lexicalSearchProvider.search(makeContext());
    section.items[0].onSelect();
    expect(setActiveScene).toHaveBeenCalledWith("scene-1");
    expect(showPanel).toHaveBeenCalledWith("editor");
  });

  it("onSelect (codex) calls requestSelectEntry + showPanel('codex')", async () => {
    const requestSelectEntry = vi.fn();
    const showPanel = vi.fn();
    vi.mocked(useCodexStore.getState).mockReturnValue({
      requestSelectEntry,
    } as never);
    vi.mocked(useLayoutStore.getState).mockReturnValue({ showPanel } as never);
    vi.mocked(invoke).mockResolvedValueOnce([
      { sourceType: "codex", id: "codex-1", title: "X", excerpt: "" },
    ]);
    const section = await lexicalSearchProvider.search(makeContext());
    section.items[0].onSelect();
    expect(requestSelectEntry).toHaveBeenCalledWith("codex-1");
    expect(showPanel).toHaveBeenCalledWith("codex");
  });

  it("onSelect (snippet) shows snippets panel only", async () => {
    const showPanel = vi.fn();
    vi.mocked(useLayoutStore.getState).mockReturnValue({ showPanel } as never);
    vi.mocked(invoke).mockResolvedValueOnce([
      { sourceType: "snippet", id: "n1", title: "X", excerpt: "" },
    ]);
    const section = await lexicalSearchProvider.search(makeContext());
    section.items[0].onSelect();
    expect(showPanel).toHaveBeenCalledWith("snippets");
  });

  it("returns error state when invoke throws", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("db locked"));
    const section = await lexicalSearchProvider.search(makeContext());
    expect(section.items).toEqual([]);
    expect(section.state).toEqual({ kind: "error", message: "db locked" });
  });

  it("returns empty section when signal is aborted before mapping", async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementationOnce(async () => {
      controller.abort();
      return [{ sourceType: "scene", id: "s1", title: "X", excerpt: "" }];
    });
    const section = await lexicalSearchProvider.search(
      makeContext({ signal: controller.signal }),
    );
    expect(section.items).toEqual([]);
  });
});
