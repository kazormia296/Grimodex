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
  // db_execute の raw 行は DB カラム名 (snake_case) キーで返る。
  // camelCase の CodexEntry をそのまま返す mock は実態とズレるので禁止。
  const fakeRow = {
    id: "codex-1",
    project_id: "proj-1",
    parent_id: null,
    type: "character",
    name: "山田太郎",
    summary: "主人公キャラ",
    content: "{}",
    icon: null,
    aliases: "[]",
    excluded_aliases: "[]",
    tags_cache: "主人公",
    context_mode: "mentioned",
    children_budget: "compact",
    source_chat_message_id: null,
    notes: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  };

  it("maps raw snake_case rows to camelCase CodexEntry", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeRow] });

    const results = await searchCodexEntries("山田太郎");

    const entry: CodexEntry = results[0];
    expect(entry.projectId).toBe("proj-1");
    expect(entry.tagsCache).toBe("主人公");
    expect(entry.contextMode).toBe("mentioned");
    expect(entry.sourceChatMessageId).toBeNull();
    expect(entry).not.toHaveProperty("project_id");
  });

  it("scopes MATCH queries to the given project (sanitized to a quoted FTS5 term)", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await searchCodexEntries("山田太郎", "proj-1");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("project_id"),
      params: ['"山田太郎"', "proj-1"],
      method: "all",
    });
  });

  it("scopes LIKE queries to the given project", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await searchCodexEntries("太郎", "proj-1");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.stringContaining("project_id"),
      params: ["%太郎%", "%太郎%", "%太郎%", "proj-1"],
      method: "all",
    });
  });

  it("stays unscoped when projectId is omitted", async () => {
    mockInvoke.mockResolvedValue({ rows: [] });

    await searchCodexEntries("山田太郎");

    expect(mockInvoke).toHaveBeenCalledWith("db_execute", {
      sql: expect.not.stringContaining("project_id"),
      params: ['"山田太郎"'],
      method: "all",
    });
  });

  it("uses MATCH for queries with 3+ characters", async () => {
    mockInvoke.mockResolvedValue({ rows: [fakeRow] });

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
    mockInvoke.mockResolvedValue({ rows: [fakeRow] });

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
