import { beforeEach, describe, expect, it, vi } from "vitest";
import { semanticSearchProvider } from "./semanticSearchProvider";
import type { ProviderSearchContext } from "./types";

vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: vi.fn(),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: { getState: vi.fn() },
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: { getState: vi.fn() },
}));

vi.mock("@/features/semantic-search/semanticNavStore", () => ({
  useSemanticNavStore: { getState: vi.fn() },
}));

import { semanticSearch } from "@/features/semantic-search/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import { useCommandCenterStore } from "../store/commandCenterStore";

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

const sampleHit = {
  sceneId: "scene-1",
  sceneTitle: "第3章",
  chunkText: "雨の中、彼は…",
  charStart: 100,
  charEnd: 150,
  score: 0.8742,
  dialogueRatio: 0.1,
};

describe("semanticSearchProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default: descriptionMode off
    useCommandCenterStore.setState({ descriptionMode: false });
  });

  it("supports only search mode", () => {
    expect(semanticSearchProvider.supportsMode("search")).toBe(true);
    expect(semanticSearchProvider.supportsMode("command")).toBe(false);
  });

  it("returns empty section without invoking when query is shorter than 2 chars", async () => {
    const section = await semanticSearchProvider.search(
      makeContext({ query: "x" }),
    );
    expect(section.items).toEqual([]);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it("skips on whitespace-only short query", async () => {
    const section = await semanticSearchProvider.search(
      makeContext({ query: "  " }),
    );
    expect(section.items).toEqual([]);
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it("invokes semanticSearch with trimmed query, ctx.limit, and descriptionMode from store (default false)", async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce([]);
    await semanticSearchProvider.search(
      makeContext({ query: "  hello world  ", limit: 50 }),
    );
    const callArgs = vi.mocked(semanticSearch).mock.calls[0]?.[0];
    expect(callArgs).toMatchObject({
      projectId: "default-project",
      query: "hello world",
      limit: 50,
      descriptionMode: false,
    });
  });

  it("passes descriptionMode=true when commandCenterStore has it enabled", async () => {
    useCommandCenterStore.setState({ descriptionMode: true });
    vi.mocked(semanticSearch).mockResolvedValueOnce([]);
    await semanticSearchProvider.search(makeContext());
    const callArgs = vi.mocked(semanticSearch).mock.calls[0]?.[0];
    expect(callArgs).toMatchObject({ descriptionMode: true });
  });

  it("cacheKeyExtras reflects descriptionMode flips", () => {
    useCommandCenterStore.setState({ descriptionMode: false });
    const off = semanticSearchProvider.cacheKeyExtras?.();
    useCommandCenterStore.setState({ descriptionMode: true });
    const on = semanticSearchProvider.cacheKeyExtras?.();
    expect(off).toBeDefined();
    expect(on).toBeDefined();
    expect(off).not.toEqual(on);
  });

  it("maps hits to CommandCenterItem with score badge and chunkText subtitle", async () => {
    vi.mocked(semanticSearch).mockResolvedValueOnce([sampleHit]);
    const section = await semanticSearchProvider.search(makeContext());
    expect(section.items).toHaveLength(1);
    const item = section.items[0];
    expect(item).toMatchObject({
      id: "semantic-chunk:scene-1:100:150",
      kind: "semantic-chunk",
      title: "第3章",
      subtitle: "雨の中、彼は…",
      badge: { label: "0.87", tone: "score" },
    });
  });

  it("onSelect calls requestJump BEFORE setActiveScene BEFORE showPanel", async () => {
    const callOrder: string[] = [];
    const requestJump = vi.fn(() => {
      callOrder.push("requestJump");
    });
    const setActiveScene = vi.fn(() => {
      callOrder.push("setActiveScene");
    });
    const showPanel = vi.fn(() => {
      callOrder.push("showPanel");
    });
    vi.mocked(useSemanticNavStore.getState).mockReturnValue({
      requestJump,
    } as never);
    vi.mocked(useTreeStore.getState).mockReturnValue({
      setActiveScene,
    } as never);
    vi.mocked(useLayoutStore.getState).mockReturnValue({ showPanel } as never);

    vi.mocked(semanticSearch).mockResolvedValueOnce([sampleHit]);
    const section = await semanticSearchProvider.search(makeContext());
    section.items[0].onSelect();

    expect(callOrder).toEqual(["requestJump", "setActiveScene", "showPanel"]);
    expect(requestJump).toHaveBeenCalledWith({
      sceneId: "scene-1",
      chunkText: "雨の中、彼は…",
    });
    expect(setActiveScene).toHaveBeenCalledWith("scene-1");
    expect(showPanel).toHaveBeenCalledWith("editor");
  });

  it("returns error state when semanticSearch throws", async () => {
    vi.mocked(semanticSearch).mockRejectedValueOnce(new Error("model load"));
    const section = await semanticSearchProvider.search(makeContext());
    expect(section.items).toEqual([]);
    expect(section.state).toEqual({ kind: "error", message: "model load" });
  });

  it("returns empty section when signal is aborted before mapping", async () => {
    const controller = new AbortController();
    vi.mocked(semanticSearch).mockImplementationOnce(async () => {
      controller.abort();
      return [sampleHit];
    });
    const section = await semanticSearchProvider.search(
      makeContext({ signal: controller.signal }),
    );
    expect(section.items).toEqual([]);
  });
});
