import { describe, expect, it, vi } from "vitest";

// loadLatestProposedProse / loadAllProposedProse の DB チェーンだけを差し替える
// (prose_staging は browser-mock に無いため実 DB では読めない)。
// select().from().where().orderBy() の戻りが loadAll では thenable、
// loadLatest では .limit(1) 付きで await される二形態をどちらも満たす。
const h = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => h.rows,
            then: (resolve: (v: unknown) => void) => resolve(h.rows),
          }),
        }),
      }),
    }),
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "proj-1",
}));

import {
  parseProposedContent,
  loadLatestProposedProse,
  loadAllProposedProse,
} from "./prose";

describe("parseProposedContent", () => {
  it("parses JSON staging payload", () => {
    const raw = JSON.stringify({
      mode: "insert",
      text: "hello",
      replaceFrom: 1,
      replaceTo: 2,
    });
    expect(parseProposedContent(raw)).toEqual({
      mode: "insert",
      text: "hello",
      replaceFrom: 1,
      replaceTo: 2,
    });
  });

  it("falls back to append for plain text", () => {
    expect(parseProposedContent("legacy plain")).toEqual({
      mode: "append",
      text: "legacy plain",
    });
  });
});

// stale 検知 (autoApplyProse) は proposal.baseVersion を比較に使う。ここで
// row.baseVersion を落とすと比較が常にスキップされ検知が無効化するため、
// 両ローダーが base_version をスレッドすることを担保する。
describe("proposed prose loaders — base_version threading", () => {
  it("loadLatestProposedProse は baseVersion を載せる", async () => {
    h.rows = [
      {
        id: "st-1",
        sceneId: "sc-1",
        proposedContent: "plain text",
        baseVersion: 4,
        status: "proposed",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    const p = await loadLatestProposedProse("sc-1");
    expect(p).toMatchObject({
      stagingId: "st-1",
      sceneId: "sc-1",
      mode: "append",
      baseVersion: 4,
    });
  });

  it("loadAllProposedProse は各行に baseVersion を載せる", async () => {
    h.rows = [
      {
        id: "st-1",
        sceneId: "sc-1",
        proposedContent: "a",
        baseVersion: 0,
      },
      {
        id: "st-2",
        sceneId: "sc-2",
        proposedContent: "b",
        baseVersion: 7,
      },
    ];
    const all = await loadAllProposedProse("proj-1");
    expect(all.map((p) => p.baseVersion)).toEqual([0, 7]);
  });
});
