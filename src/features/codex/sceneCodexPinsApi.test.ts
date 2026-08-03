import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/db/client", () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/db/schema", () => ({
  sceneCodexPins: {
    sceneId: "sceneId",
    entryId: "entryId",
    createdAt: "createdAt",
  },
  sceneCodexMentions: {
    sceneId: "sceneId",
    codexEntryId: "codexEntryId",
    source: "source",
    role: "role",
  },
  treeNodes: {
    id: "id",
    projectId: "projectId",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray) => ({ sql: strings.raw[0] })),
    {},
  ),
}));

import { db } from "@/db/client";
const mockDb = vi.mocked(db);

import {
  upsertScenePin,
  deleteScenePin,
  listSceneCodexMentions,
} from "./sceneCodexPinsApi";

type MockChain = Record<string, ReturnType<typeof vi.fn>>;

function setupInsert(resolveWith: unknown = undefined): MockChain {
  const chain: MockChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(resolveWith),
    onConflictDoUpdate: vi.fn().mockResolvedValue(resolveWith),
  };
  mockDb.insert.mockReturnValue(chain as never);
  return chain;
}

function setupDelete(resolveWith: unknown = undefined): MockChain {
  const chain: MockChain = {
    where: vi.fn().mockResolvedValue(resolveWith),
  };
  mockDb.delete.mockReturnValue(chain as never);
  return chain;
}

describe("upsertScenePin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts into scene_codex_pins first, then upserts source='relation' row", async () => {
    const calls: string[] = [];
    // First insert call = pins, second insert call = mentions
    mockDb.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        onConflictDoNothing: vi.fn(async () => {
          calls.push("pins");
        }),
      } as never)
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        onConflictDoUpdate: vi.fn(async () => {
          calls.push("mentions");
        }),
      } as never);

    await upsertScenePin("scene1", "entry1");
    expect(calls).toEqual(["pins", "mentions"]);
  });

  it("writes source='relation', role='mentioned' into scene_codex_mentions", async () => {
    setupInsert(); // pins
    const mentionsChain = setupInsert(); // reused for second insert
    // Second call for mentions
    let mentionsValues: unknown;
    mockDb.insert
      .mockReturnValueOnce({
        values: vi.fn().mockReturnThis(),
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      } as never)
      .mockReturnValueOnce({
        values: vi.fn((v: unknown) => {
          mentionsValues = v;
          return { onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) };
        }),
      } as never);
    void mentionsChain;

    await upsertScenePin("scene1", "entry1");
    expect(mentionsValues).toEqual([
      {
        sceneId: "scene1",
        codexEntryId: "entry1",
        source: "relation",
        role: "mentioned",
      },
    ]);
  });
});

describe("listSceneCodexMentions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not query persistence for an empty scene scope", async () => {
    await expect(listSceneCodexMentions([])).resolves.toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns the typed mention projection for the requested scenes", async () => {
    const rows = [
      {
        sceneId: "scene1",
        codexEntryId: "entry1",
        source: "body",
        role: "mentioned",
      },
    ];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows),
    } as never);

    await expect(listSceneCodexMentions(["scene1"])).resolves.toEqual(rows);
  });
});

describe("deleteScenePin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes from scene_codex_pins first, then deletes source='relation' row", async () => {
    const calls: string[] = [];
    mockDb.delete
      .mockReturnValueOnce({
        where: vi.fn(async () => {
          calls.push("pins");
        }),
      } as never)
      .mockReturnValueOnce({
        where: vi.fn(async () => {
          calls.push("mentions");
        }),
      } as never);

    await deleteScenePin("scene1", "entry1");
    expect(calls).toEqual(["pins", "mentions"]);
  });

  it("calls db.delete twice (pins then mentions)", async () => {
    setupDelete();
    setupDelete();
    // Both return same mock - just verify called twice
    mockDb.delete.mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    } as never);

    await deleteScenePin("scene1", "entry1");
    expect(mockDb.delete).toHaveBeenCalledTimes(2);
  });
});
