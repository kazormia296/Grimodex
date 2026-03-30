import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Snippet } from "./api";

// Mock invoke before importing search module
const mockInvoke = vi.fn();
vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const { searchSnippets } = await import("./search");

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("searchSnippets", () => {
  const fakeSnippet: Snippet = {
    id: 1,
    title: "森の描写メモ",
    content: "暗い森の中、一筋の光が差し込んだ。",
    tags: "描写,森",
    sceneId: null,
    sourceChatMessageId: null,
    createdAt: "2025-01-01T00:00:00Z",
  };

  it("uses MATCH for queries with 3+ characters", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeSnippet] });

    const results = await searchSnippets("森の描写");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("MATCH"),
      params: expect.any(Array),
      method: "all",
    });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("森の描写メモ");
  });

  it("uses LIKE for queries with fewer than 3 characters", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeSnippet] });

    const results = await searchSnippets("描写");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("LIKE"),
      params: expect.any(Array),
      method: "all",
    });
    expect(results).toHaveLength(1);
  });

  it("returns empty array for empty query", async () => {
    const results = await searchSnippets("");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
