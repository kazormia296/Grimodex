import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snippet } from "./api";

const { mockInvoke, mockDbWhere } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockDbWhere: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@/db/client", () => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: (...args: unknown[]) => mockDbWhere(...args),
  };
  return { db: chain };
});

const { searchSnippets } = await import("./search");

const fakeSnippet: Snippet = {
  id: "snippet-1",
  projectId: "default-project",
  title: "森の描写メモ",
  content: "暗い森の中、一筋の光が差し込んだ。",
  tagsCache: '["描写","森"]',
  contentSource: null,
  sceneId: null,
  sourceChatMessageId: null,
  usageCount: 0,
  version: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockDbWhere.mockReset();
  mockDbWhere.mockResolvedValue([]);
});

describe("searchSnippets", () => {
  it("uses typed project FTS and hydrates the complete snippet", async () => {
    mockInvoke.mockResolvedValue([
      { sourceType: "snippet", id: fakeSnippet.id },
    ]);
    mockDbWhere.mockResolvedValue([fakeSnippet]);

    const results = await searchSnippets("森の描写");

    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("fts_search", {
      projectId: "default-project",
      query: "森の描写",
      scope: "snippets",
      limit: 50,
    });
    expect(results).toEqual([fakeSnippet]);
  });

  it("returns empty without hydrating when FTS has no hit", async () => {
    mockInvoke.mockResolvedValue([]);

    expect(await searchSnippets("不存在")).toEqual([]);
    expect(mockDbWhere).not.toHaveBeenCalled();
  });

  it("returns empty for an empty query", async () => {
    expect(await searchSnippets("")).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
