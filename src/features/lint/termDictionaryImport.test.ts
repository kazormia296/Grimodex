import { describe, expect, it } from "vitest";

import { planBulkImport, type PlannerRow } from "./termDictionaryImport";
import type { ParsedTermEntry } from "./termDictionaryCsv";

const row = (over: Partial<PlannerRow>): PlannerRow => ({
  id: "r1",
  preferred: "ウェブ",
  variants: ["web"],
  severity: "warning",
  note: null,
  enabled: true,
  sortOrder: 0,
  ...over,
});

const parsed = (over: Partial<ParsedTermEntry>): ParsedTermEntry => ({
  preferred: "ウェブ",
  variants: ["web", "Web"],
  severity: "warning",
  note: null,
  enabled: true,
  ...over,
});

describe("planBulkImport - replace", () => {
  it("既存を全削除し、取込を全挿入する", () => {
    const existing = [row({ id: "a" }), row({ id: "b", preferred: "旧" })];
    const plan = planBulkImport(
      existing,
      [parsed({ preferred: "新", variants: ["x"] })],
      "replace",
    );
    expect(plan.deletes).toEqual(["a", "b"]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      preferred: "新",
      variants: ["x"],
      sortOrder: 0,
    });
    expect(plan.result).toMatchObject({ added: 1, updated: 0 });
  });

  it("取込内で variant が衝突したら先勝ち、後発はスキップ", () => {
    const plan = planBulkImport(
      [],
      [
        parsed({ preferred: "A", variants: ["dup"] }),
        parsed({ preferred: "B", variants: ["dup"] }),
      ],
      "replace",
    );
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0].preferred).toBe("A");
    expect(plan.result.skipped).toEqual([
      { preferred: "B", reason: expect.any(String) },
    ]);
  });

  it("sortOrder は 0 から連番", () => {
    const plan = planBulkImport(
      [],
      [
        parsed({ preferred: "A", variants: ["a"] }),
        parsed({ preferred: "B", variants: ["b"] }),
      ],
      "replace",
    );
    expect(plan.inserts.map((i) => i.sortOrder)).toEqual([0, 1]);
  });
});

describe("planBulkImport - merge", () => {
  it("preferred 一致は更新、新規は追加、既存は据え置き", () => {
    const existing = [
      row({ id: "keep", preferred: "残す", variants: ["keepv"] }),
      row({ id: "upd", preferred: "ウェブ", variants: ["web"], sortOrder: 5 }),
    ];
    const plan = planBulkImport(
      existing,
      [
        parsed({ preferred: "ウェブ", variants: ["web", "Web", "ウエブ"] }),
        parsed({ preferred: "子ども", variants: ["子供"] }),
      ],
      "merge",
    );
    expect(plan.deletes).toEqual([]);
    expect(plan.updates).toEqual([
      {
        id: "upd",
        preferred: "ウェブ",
        variants: ["web", "Web", "ウエブ"],
        severity: "warning",
        note: null,
        enabled: true,
      },
    ]);
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      preferred: "子ども",
      variants: ["子供"],
      sortOrder: 6, // max(existing sortOrder)=5 の次
    });
    expect(plan.result).toMatchObject({ added: 1, updated: 1 });
  });

  it("更新時、自分の旧 variant を衝突扱いしない", () => {
    const existing = [row({ id: "x", preferred: "ウェブ", variants: ["web"] })];
    const plan = planBulkImport(
      existing,
      [parsed({ preferred: "ウェブ", variants: ["web", "Web"] })],
      "merge",
    );
    expect(plan.updates[0].variants).toEqual(["web", "Web"]);
  });

  it("新規 variant が別の既存エントリと衝突したら落とす", () => {
    const existing = [
      row({ id: "own", preferred: "所有", variants: ["shared"] }),
    ];
    const plan = planBulkImport(
      existing,
      [parsed({ preferred: "新規", variants: ["shared", "uniq"] })],
      "merge",
    );
    expect(plan.inserts[0].variants).toEqual(["uniq"]);
  });

  it("全 variant が他エントリと衝突したらスキップ", () => {
    const existing = [
      row({ id: "own", preferred: "所有", variants: ["shared"] }),
    ];
    const plan = planBulkImport(
      existing,
      [parsed({ preferred: "新規", variants: ["shared"] })],
      "merge",
    );
    expect(plan.inserts).toHaveLength(0);
    expect(plan.result.skipped).toHaveLength(1);
  });

  it("既存を変更しない（引数配列を破壊しない）", () => {
    const existing = [row({ id: "x", preferred: "ウェブ", variants: ["web"] })];
    planBulkImport(
      existing,
      [parsed({ preferred: "ウェブ", variants: ["web", "Web"] })],
      "merge",
    );
    expect(existing[0].variants).toEqual(["web"]);
  });
});
