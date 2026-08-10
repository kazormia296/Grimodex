import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const returningMock = vi.fn();
const limitMock = vi.fn();
const updateWhereMock = vi.fn((_condition: unknown) => ({
  returning: returningMock,
}));
const insertReturningMock = vi.fn();
let selectQueue: unknown[][] = [];

vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({ where: updateWhereMock }),
    }),
    insert: () => ({
      values: () => ({
        returning: insertReturningMock,
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: limitMock,
          then: (resolve: (v: unknown) => void) => {
            const next = selectQueue.shift() ?? [];
            resolve(next);
          },
        }),
      }),
    }),
  },
}));

import { createDefinition, updateDefinition, upsertValue } from "./detailApi";
import {
  DetailDefinitionVersionConflictError,
  DetailValueVersionConflictError,
} from "./detailOcc";

beforeEach(() => {
  returningMock.mockReset();
  limitMock.mockReset();
  updateWhereMock.mockClear();
  insertReturningMock.mockReset();
  selectQueue = [];
});

describe("detailApi OCC", () => {
  it("createDefinition starts at version 0", async () => {
    insertReturningMock.mockResolvedValueOnce([
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "年齢",
        version: 0,
      },
    ]);
    const created = await createDefinition({
      id: "d1",
      projectId: "p1",
      typeSlug: "character",
      name: "年齢",
    });
    expect(created.version).toBe(0);
  });

  it("updateDefinition CAS-bumps version on baseVersion match", async () => {
    returningMock.mockResolvedValueOnce([
      { id: "d1", version: 3, includeInContext: 1 },
    ]);
    const updated = await updateDefinition(
      "d1",
      { includeInContext: 1 },
      { baseVersion: 2 },
    );
    expect(updated?.version).toBe(3);
    const dialect = new SQLiteSyncDialect();
    const condition = updateWhereMock.mock.calls[0]?.[0] as SQL;
    expect(dialect.sqlToQuery(condition).sql).toContain("version");
  });

  it("updateDefinition throws on version conflict", async () => {
    returningMock.mockResolvedValueOnce([]);
    limitMock.mockResolvedValueOnce([{ id: "d1" }]);
    await expect(
      updateDefinition("d1", { name: "x" }, { baseVersion: 1 }),
    ).rejects.toBeInstanceOf(DetailDefinitionVersionConflictError);
  });

  it("upsertValue inserts version 1 when absent", async () => {
    // getDefinition
    selectQueue.push([
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "年齢",
        fieldType: "dropdown",
        fieldConfig: '{"options":["主人公"]}',
        sortOrder: 1,
      },
    ]);
    // existing value lookup
    selectQueue.push([]);
    insertReturningMock.mockResolvedValueOnce([
      {
        id: "v1",
        entryId: "e1",
        definitionId: "d1",
        value: "主人公",
        version: 1,
      },
    ]);
    const saved = await upsertValue("e1", "d1", "主人公");
    expect(saved.version).toBe(1);
  });

  it("upsertValue requires baseVersion and CAS-bumps when present", async () => {
    selectQueue.push([
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "役割",
        fieldType: "dropdown",
        fieldConfig: '{"options":["主人公","脇役"]}',
        sortOrder: 1,
      },
    ]);
    selectQueue.push([
      {
        id: "v1",
        entryId: "e1",
        definitionId: "d1",
        value: "主人公",
        version: 2,
      },
    ]);
    returningMock.mockResolvedValueOnce([
      {
        id: "v1",
        entryId: "e1",
        definitionId: "d1",
        value: "脇役",
        version: 3,
      },
    ]);
    const saved = await upsertValue("e1", "d1", "脇役", { baseVersion: 2 });
    expect(saved.version).toBe(3);
  });

  it("upsertValue throws DetailValueVersionConflictError on stale baseVersion", async () => {
    selectQueue.push([
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "役割",
        fieldType: "dropdown",
        fieldConfig: '{"options":["主人公"]}',
        sortOrder: 1,
      },
    ]);
    selectQueue.push([
      {
        id: "v1",
        entryId: "e1",
        definitionId: "d1",
        value: "主人公",
        version: 4,
      },
    ]);
    returningMock.mockResolvedValueOnce([]);
    await expect(
      upsertValue("e1", "d1", "主人公", { baseVersion: 2 }),
    ).rejects.toBeInstanceOf(DetailValueVersionConflictError);
  });

  it("upsertValue rejects updates without baseVersion when a row already exists", async () => {
    selectQueue.push([
      {
        id: "d1",
        projectId: "p1",
        typeSlug: "character",
        name: "役割",
        fieldType: "dropdown",
        fieldConfig: '{"options":["主人公"]}',
        sortOrder: 1,
      },
    ]);
    selectQueue.push([
      {
        id: "v1",
        entryId: "e1",
        definitionId: "d1",
        value: "主人公",
        version: 1,
      },
    ]);
    await expect(upsertValue("e1", "d1", "主人公")).rejects.toBeInstanceOf(
      DetailValueVersionConflictError,
    );
  });
});
