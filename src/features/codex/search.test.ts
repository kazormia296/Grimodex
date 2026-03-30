import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CodexEntry } from "./api";

// Mock invoke before importing search module
const mockInvoke = vi.fn();
vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Import after mock setup
const { searchCodexEntries } = await import("./search");

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("searchCodexEntries", () => {
  const fakeEntry: CodexEntry = {
    id: 1,
    type: "character",
    name: "山田太郎",
    summary: "主人公キャラ",
    content: "勇敢な青年。",
    tags: "主人公",
    sourceChatMessageId: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };

  it("uses MATCH for queries with 3+ characters", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeEntry] });

    const results = await searchCodexEntries("山田太郎");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("MATCH"),
      params: expect.any(Array),
      method: "all",
    });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("山田太郎");
  });

  it("uses LIKE for queries with fewer than 3 characters", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeEntry] });

    const results = await searchCodexEntries("太郎");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("LIKE"),
      params: expect.any(Array),
      method: "all",
    });
    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.not.stringContaining("MATCH"),
      params: expect.any(Array),
      method: "all",
    });
    expect(results).toHaveLength(1);
  });

  it("uses LIKE for single character queries", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await searchCodexEntries("剣");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("LIKE"),
      params: expect.any(Array),
      method: "all",
    });
  });

  it("wraps LIKE param with % wildcards", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await searchCodexEntries("太郎");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.any(String),
      params: expect.arrayContaining(["%太郎%"]),
      method: "all",
    });
  });

  it("returns empty array for empty query", async () => {
    const results = await searchCodexEntries("");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("returns empty array for whitespace-only query", async () => {
    const results = await searchCodexEntries("   ");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });
});
