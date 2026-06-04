// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock("@/db/client", () => ({ db: { select: dbSelectMock } }));

import { buildMapProvenance } from "./provenance";

/**
 * buildMapProvenance issues up to 3 sequential `db.select().from().where()`
 * calls: boards → stickies → AI authorship_spans. Return canned rows per call
 * in order.
 *
 * NOTE: this mock ignores the `.where()` clause, so it gates the aggregation
 * (per-sticky summing, label fallbacks) but NOT the `source = 'ai'` filter or
 * the stickyId/project scoping in the query — those run in the real query and
 * are assumed correct here. Don't add cases that "prove" the filter; they'd be
 * vacuous against this mock.
 */
function queueQueries(...resultsInOrder: unknown[][]): void {
  let i = 0;
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => Promise.resolve(resultsInOrder[i++] ?? []),
    }),
  }));
}

describe("buildMapProvenance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty when the project has no boards", async () => {
    queueQueries([]);
    expect(await buildMapProvenance("p1")).toEqual({
      totalAiChars: 0,
      stickyCount: 0,
      stickies: [],
    });
  });

  it("returns empty when boards exist but have no stickies", async () => {
    queueQueries([{ id: "b1", title: "World" }], []);
    expect((await buildMapProvenance("p1")).stickyCount).toBe(0);
  });

  it("aggregates AI spans per sticky with board/sticky labels", async () => {
    queueQueries(
      [{ id: "b1", title: "World" }],
      [
        { id: "s1", boardId: "b1", title: "Dragon", previewText: null },
        { id: "s2", boardId: "b1", title: null, previewText: "Castle lore" },
      ],
      [
        { stickyId: "s1", fromPos: 0, toPos: 10, model: "m" },
        // second AI span on the same sticky must accumulate
        { stickyId: "s1", fromPos: 10, toPos: 15, model: "m" },
        { stickyId: "s2", fromPos: 0, toPos: 7, model: null },
      ],
    );

    const r = await buildMapProvenance("p1");

    expect(r.totalAiChars).toBe(22); // 15 + 7
    expect(r.stickyCount).toBe(2);
    const s1 = r.stickies.find((s) => s.stickyId === "s1");
    expect(s1).toMatchObject({
      boardTitle: "World",
      stickyTitle: "Dragon",
      charCount: 15,
    });
    // title is null → falls back to previewText
    const s2 = r.stickies.find((s) => s.stickyId === "s2");
    expect(s2?.stickyTitle).toBe("Castle lore");
    expect(s2?.charCount).toBe(7);
  });

  it("labels a titleless, previewless sticky as (untitled)", async () => {
    queueQueries(
      [{ id: "b1", title: "World" }],
      [{ id: "s1", boardId: "b1", title: null, previewText: null }],
      [{ stickyId: "s1", fromPos: 0, toPos: 5, model: null }],
    );
    const r = await buildMapProvenance("p1");
    expect(r.stickies[0].stickyTitle).toBe("(untitled)");
  });
});
