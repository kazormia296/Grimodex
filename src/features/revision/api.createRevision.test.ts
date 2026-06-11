// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";

// 採番レースの回帰テスト。JS 側で max+1 を先読みして INSERT すると、
// 並走する saveFn (flush 二重発火) が同じ番号を計算して UNIQUE
// (entity_type, entity_id, version_number) 衝突になり auto-revision が
// 保存されない (実機ログで確認)。採番は INSERT 内サブクエリで原子的に行う。

const calls = vi.hoisted(
  () =>
    ({ list: [] }) as {
      list: { sql: string; params: unknown[]; method: string }[];
    },
);

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(
    async (
      _cmd: string,
      args: { sql: string; params: unknown[]; method: string },
    ) => {
      calls.list.push(args);
      if (/^\s*select/i.test(args.sql)) return { rows: [] };
      return {
        rows: [
          {
            id: "r1",
            entity_type: "scene",
            entity_id: "s1",
            content: "X",
            version_number: 1,
            snapshot_type: "auto",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    },
  ),
}));

import { createRevision } from "./api";

describe("createRevision", () => {
  it("採番は INSERT 内サブクエリで原子的に行う (リテラル番号を渡さない)", async () => {
    const rev = await createRevision({
      entityType: "scene",
      entityId: "s1",
      content: "X",
      snapshotType: "auto",
    });
    expect(rev).not.toBeNull();

    const insert = calls.list.find((c) => /insert into/i.test(c.sql));
    expect(insert).toBeDefined();
    // version_number はサブクエリ (coalesce(max(...)) + 1) で計算される
    expect(insert!.sql).toMatch(/coalesce\(max\(/i);
    // JS 先読みのリテラル番号が params に乗っていない
    expect(insert!.params.filter((p) => typeof p === "number")).toEqual([]);
  });
});
