import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/db/client", () => ({ db: { insert: vi.fn(), delete: vi.fn() } }));
vi.mock("@/db/schema", () => ({
  sceneCodexMentions: {
    sceneId: "sceneId",
    codexEntryId: "codexEntryId",
    source: "source",
    role: "role",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  notInArray: vi.fn((col: unknown, vals: unknown) => ({
    notInArray: [col, vals],
  })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray) => ({ sql: strings.raw[0] })),
    {},
  ),
}));
vi.mock("@/features/codex/rustMatcher", () => ({
  findMentionedEntriesAsync: vi.fn(),
}));

import { db } from "@/db/client";
const mockDb = vi.mocked(db);

import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
const mockFindMentioned = vi.mocked(findMentionedEntriesAsync);

import { upsertSceneBodyMentions } from "./bodyMentionApi";

interface InsertChain {
  values: ReturnType<typeof vi.fn>;
  onConflictDoUpdate: ReturnType<typeof vi.fn>;
}
interface DeleteChain {
  where: ReturnType<typeof vi.fn>;
}

function mockInsertChain(): InsertChain {
  const chain: InsertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.insert.mockReturnValue(chain as never);
  return chain;
}
function mockDeleteChain(): DeleteChain {
  const chain: DeleteChain = { where: vi.fn().mockResolvedValue(undefined) };
  mockDb.delete.mockReturnValue(chain as never);
  return chain;
}

describe("upsertSceneBodyMentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts body mentions BEFORE deleting stale rows (fail-safe ordering)", async () => {
    const ops: string[] = [];
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn(async () => {
        ops.push("insert");
      }),
    } as never);
    mockDb.delete.mockReturnValue({
      where: vi.fn(async () => {
        ops.push("delete");
      }),
    } as never);

    mockFindMentioned.mockResolvedValue([
      { id: "e1", name: "太郎", type: "character" } as never,
    ]);

    await upsertSceneBodyMentions("s1", '{"type":"doc","content":[]}', [
      { id: "e1", name: "太郎", type: "character" } as never,
    ]);

    expect(ops).toEqual(["insert", "delete"]);
  });

  it("inserts one row per matched entry with source='body' and role='mentioned'", async () => {
    const insertChain = mockInsertChain();
    mockDeleteChain();

    mockFindMentioned.mockResolvedValue([
      { id: "e1", name: "太郎", type: "character" } as never,
      { id: "e2", name: "花子", type: "character" } as never,
    ]);

    await upsertSceneBodyMentions("s1", '{"type":"doc"}', [
      { id: "e1", name: "太郎", type: "character" } as never,
      { id: "e2", name: "花子", type: "character" } as never,
    ]);

    expect(insertChain.values).toHaveBeenCalledWith([
      { sceneId: "s1", codexEntryId: "e1", source: "body", role: "mentioned" },
      { sceneId: "s1", codexEntryId: "e2", source: "body", role: "mentioned" },
    ]);
  });

  it("skips insert when no entries matched", async () => {
    mockInsertChain();
    mockDeleteChain();
    mockFindMentioned.mockResolvedValue([]);

    await upsertSceneBodyMentions("s1", '{"type":"doc"}', [
      { id: "e1", name: "太郎", type: "character" } as never,
    ]);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it("does nothing when entries array is empty", async () => {
    await upsertSceneBodyMentions("s1", '{"type":"doc"}', []);

    expect(mockFindMentioned).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it("prunes stale body rows (not in new match set)", async () => {
    mockInsertChain();
    const deleteChain = mockDeleteChain();
    mockFindMentioned.mockResolvedValue([
      { id: "e1", name: "太郎", type: "character" } as never,
    ]);

    await upsertSceneBodyMentions("s1", '{"type":"doc"}', [
      { id: "e1", name: "太郎", type: "character" } as never,
      { id: "e2", name: "花子", type: "character" } as never,
    ]);

    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });
});
