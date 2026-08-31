// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CasingCache } from "drizzle-orm/casing";

const { dbSelectMock, whereMock, resetSequenceMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  whereMock: vi.fn(),
  resetSequenceMock: vi.fn(() => Promise.resolve(0)),
}));

vi.mock("@/db/client", () => ({
  db: { select: dbSelectMock },
}));
vi.mock("@/features/settings/api", () => ({
  getTimelapseResetSequence: resetSequenceMock,
}));

import { loadProjectChangeEvents, loadSceneChangeEvents } from "./queryEvents";

function renderCondition(condition: unknown): {
  sql: string;
  params: unknown[];
} {
  return (
    condition as {
      toQuery: (config: {
        casing: CasingCache;
        escapeName: (name: string) => string;
        escapeParam: (index: number, value: unknown) => string;
        escapeString: (value: string) => string;
      }) => { sql: string; params: unknown[] };
    }
  ).toQuery({
    casing: new CasingCache(),
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `?${index}`,
    escapeString: (value) => `'${value.replaceAll("'", "''")}'`,
  });
}

describe("timelapse event queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSequenceMock.mockResolvedValue(0);
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: (condition: unknown) => {
          whereMock(condition);
          return {
            orderBy: () =>
              Promise.resolve([
                { sequence: 13, projectId: "p1", sceneId: "s1" },
              ]),
          };
        },
      }),
    }));
  });

  it("applies resetSequence to project and scene feeds", async () => {
    resetSequenceMock.mockResolvedValue(12);

    await expect(loadProjectChangeEvents("p1")).resolves.toEqual([
      { sequence: 13, projectId: "p1", sceneId: "s1" },
    ]);
    await expect(loadSceneChangeEvents("p1", "s1")).resolves.toEqual([
      { sequence: 13, projectId: "p1", sceneId: "s1" },
    ]);

    expect(resetSequenceMock).toHaveBeenNthCalledWith(1, "p1");
    expect(resetSequenceMock).toHaveBeenNthCalledWith(2, "p1");
    expect(whereMock).toHaveBeenCalledTimes(2);
    for (const [condition] of whereMock.mock.calls) {
      const query = renderCondition(condition);
      expect(query.sql).toContain("sequence");
      expect(query.sql).toContain("> ");
      expect(query.params).toContain(12);
    }
  });
});
