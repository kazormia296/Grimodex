import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexEntry } from "./api";

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

const { searchCodexEntries } = await import("./search");

const fakeEntry: CodexEntry = {
  id: "codex-1",
  projectId: "proj-1",
  parentId: null,
  type: "character",
  name: "山田太郎",
  summary: "主人公キャラ",
  content: "{}",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  readings: null,
  tagsCache: "主人公",
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-01T00:00:00Z",
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockDbWhere.mockReset();
  mockDbWhere.mockResolvedValue([]);
});

describe("searchCodexEntries", () => {
  it("uses the typed project-scoped FTS command and hydrates full entities", async () => {
    mockInvoke.mockResolvedValue([{ sourceType: "codex", id: fakeEntry.id }]);
    mockDbWhere.mockResolvedValue([fakeEntry]);

    const results = await searchCodexEntries("山田太郎", "proj-1");

    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("fts_search", {
      projectId: "proj-1",
      query: "山田太郎",
      scope: "codex",
      limit: 50,
    });
    expect(results).toEqual([fakeEntry]);
  });

  it("preserves native FTS rank order while hydrating rows", async () => {
    const second = { ...fakeEntry, id: "codex-2", name: "次郎" };
    mockInvoke.mockResolvedValue([
      { sourceType: "codex", id: second.id },
      { sourceType: "codex", id: fakeEntry.id },
    ]);
    mockDbWhere.mockResolvedValue([fakeEntry, second]);

    const results = await searchCodexEntries("山田", "proj-1");

    expect(results.map((entry) => entry.id)).toEqual([second.id, fakeEntry.id]);
  });

  it("keeps the legacy unscoped caller on typed Drizzle predicates", async () => {
    mockDbWhere.mockResolvedValue([fakeEntry]);

    const results = await searchCodexEntries("太郎");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(results).toEqual([fakeEntry]);
  });

  it("does not query entity rows when FTS has no project hit", async () => {
    mockInvoke.mockResolvedValue([]);

    expect(await searchCodexEntries("不存在", "proj-1")).toEqual([]);
    expect(mockDbWhere).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("returns empty for %j", async (query) => {
    expect(await searchCodexEntries(query, "proj-1")).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockDbWhere).not.toHaveBeenCalled();
  });
});
