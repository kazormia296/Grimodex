import { beforeEach, describe, expect, it, vi } from "vitest";
import { quickOpenProvider } from "./quickOpenProvider";
import type { ProviderSearchContext } from "./types";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: vi.fn() },
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: { getState: vi.fn() },
}));
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: { getState: vi.fn() },
}));
vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn() },
}));

import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
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
    descriptionMode: false,
    ...overrides,
  };
}

describe("quickOpenProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTreeStore.getState).mockReturnValue({
      nodes: [
        { id: "s1", nodeType: "scene", title: "邂逅の章" },
        { id: "s2", nodeType: "scene", title: "別離" },
        { id: "n1", nodeType: "note", title: "邂逅メモ" },
      ],
      setActiveScene: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useCodexStore.getState).mockReturnValue({
      entries: [{ id: "c1", name: "邂逅 (人物)" }],
      requestSelectEntry: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useSnippetStore.getState).mockReturnValue({
      entries: [{ id: "sn1", title: "雨" }],
      requestSelectEntry: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useLayoutStore.getState).mockReturnValue({
      showPanel: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it("registers as bar surface, search mode only", () => {
    expect(quickOpenProvider.surfaces).toEqual(["bar"]);
    expect(quickOpenProvider.supportsMode("search")).toBe(true);
    expect(quickOpenProvider.supportsMode("command")).toBe(false);
  });

  it("returns empty section for blank query", async () => {
    const section = await quickOpenProvider.search(makeContext({ query: "" }));
    expect(section.items).toEqual([]);
  });

  it("matches scene/codex by title and skips notes", async () => {
    const section = await quickOpenProvider.search(
      makeContext({ query: "邂逅" }),
    );
    const ids = section.items.map((i) => i.id);
    expect(ids).toContain("quickopen-scene:s1");
    expect(ids).toContain("quickopen-codex:c1");
    expect(ids).not.toContain("quickopen-scene:n1"); // note は対象外
    expect(ids).not.toContain("quickopen-snippet:sn1"); // 雨 はヒットしない
  });

  it("prefix match outranks substring match", async () => {
    vi.mocked(useTreeStore.getState).mockReturnValue({
      nodes: [
        { id: "a", nodeType: "scene", title: "雨の邂逅" }, // substring
        { id: "b", nodeType: "scene", title: "邂逅の章" }, // prefix
      ],
      setActiveScene: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useCodexStore.getState).mockReturnValue({
      entries: [],
      requestSelectEntry: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    vi.mocked(useSnippetStore.getState).mockReturnValue({
      entries: [],
      requestSelectEntry: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const section = await quickOpenProvider.search(
      makeContext({ query: "邂逅" }),
    );
    // 邂逅の章 (prefix) が先に来る
    expect(section.items[0].id).toBe("quickopen-scene:b");
    expect(section.items[1].id).toBe("quickopen-scene:a");
  });
});
