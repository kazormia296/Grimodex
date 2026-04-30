import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

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

import { db } from "@/db/client";
const mockDb = vi.mocked(db);

import { upsertSceneBeatMentions } from "./mentionApi";
import type { BeatMention } from "./extractBeatMentions";

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
  const chain: DeleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.delete.mockReturnValue(chain as never);
  return chain;
}

describe("upsertSceneBeatMentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts new mentions BEFORE deleting stale ones (fail-safe ordering)", async () => {
    // Order matters: the previous implementation deleted first, so an
    // insert failure left the table empty. The new contract is insert →
    // delete-stale.
    const ops: string[] = [];
    const insertChain: InsertChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn(async () => {
        ops.push("insert");
      }),
    };
    const deleteChain: DeleteChain = {
      where: vi.fn(async () => {
        ops.push("delete");
      }),
    };
    mockDb.insert.mockReturnValue(insertChain as never);
    mockDb.delete.mockReturnValue(deleteChain as never);

    const mentions: BeatMention[] = [
      { beatId: "b1", codexId: "c1", role: "actor" },
      { beatId: "b1", codexId: "c2", role: "mentioned" },
    ];
    await upsertSceneBeatMentions("s1", mentions);

    expect(ops).toEqual(["insert", "delete"]);
  });

  it("upserts the desired set with onConflictDoUpdate to refresh role", async () => {
    const insertChain = mockInsertChain();
    mockDeleteChain();

    const mentions: BeatMention[] = [
      { beatId: "b1", codexId: "c1", role: "actor" },
      { beatId: "b1", codexId: "c2", role: "target" },
    ];
    await upsertSceneBeatMentions("s1", mentions);

    expect(insertChain.values).toHaveBeenCalledWith([
      { sceneId: "s1", codexEntryId: "c1", source: "beat", role: "actor" },
      { sceneId: "s1", codexEntryId: "c2", source: "beat", role: "target" },
    ]);
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips insert entirely when mentions is empty", async () => {
    mockInsertChain();
    const deleteChain = mockDeleteChain();

    await upsertSceneBeatMentions("s1", []);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });

  it("when insert fails, the stale delete is NOT attempted (data preserved)", async () => {
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("disk full")),
    } as never);
    const deleteChain = mockDeleteChain();

    await expect(
      upsertSceneBeatMentions("s1", [
        { beatId: "b1", codexId: "c1", role: "actor" },
      ]),
    ).rejects.toThrow("disk full");

    expect(deleteChain.where).not.toHaveBeenCalled();
  });
});
