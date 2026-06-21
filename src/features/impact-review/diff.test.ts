import { describe, it, expect } from "vitest";
import {
  computeCodexDiff,
  summarizeChanges,
  computeChangeId,
  type CodexSnapshot,
} from "./diff";

const base: CodexSnapshot = {
  name: "アリス",
  aliases: ["アリー"],
  summary: "15歳の少女。黒髪。",
  contentPlain: "町外れに住む。",
  details: [
    { name: "年齢", value: "15" },
    { name: "髪色", value: "黒" },
  ],
};

describe("computeCodexDiff", () => {
  it("returns no changes when snapshots are identical", () => {
    const changes = computeCodexDiff(base, { ...base });
    expect(changes).toEqual([]);
  });

  it("detects a detail value change", () => {
    const cur: CodexSnapshot = {
      ...base,
      details: [
        { name: "年齢", value: "17" },
        { name: "髪色", value: "黒" },
      ],
    };
    const changes = computeCodexDiff(base, cur);
    expect(changes).toEqual([
      { field: "detail", name: "年齢", old: "15", new: "17" },
    ]);
  });

  it("detects summary and name changes", () => {
    const cur: CodexSnapshot = { ...base, name: "アリシア", summary: "17歳。" };
    const changes = computeCodexDiff(base, cur);
    expect(changes).toContainEqual({
      field: "name",
      name: null,
      old: "アリス",
      new: "アリシア",
    });
    expect(changes).toContainEqual({
      field: "summary",
      name: null,
      old: "15歳の少女。黒髪。",
      new: "17歳。",
    });
  });

  it("treats added / removed details as old='' / new=''", () => {
    const cur: CodexSnapshot = {
      ...base,
      details: [
        { name: "年齢", value: "15" },
        // 髪色 removed
        { name: "出身", value: "辺境" }, // added
      ],
    };
    const changes = computeCodexDiff(base, cur);
    expect(changes).toContainEqual({
      field: "detail",
      name: "髪色",
      old: "黒",
      new: "",
    });
    expect(changes).toContainEqual({
      field: "detail",
      name: "出身",
      old: "",
      new: "辺境",
    });
  });

  it("compares aliases order-insensitively", () => {
    const cur: CodexSnapshot = { ...base, aliases: ["アリー"] };
    expect(computeCodexDiff(base, cur)).toEqual([]);
    const cur2: CodexSnapshot = { ...base, aliases: ["アリー", "白の魔女"] };
    const changes = computeCodexDiff(base, cur2);
    expect(changes.some((c) => c.field === "aliases")).toBe(true);
  });

  it("detects alias edits that would collide under delimiter-less join", () => {
    // ["ab","c"] と ["a","bc"] は区切り無し連結だと共に "abc" となり潰れる。
    const b: CodexSnapshot = { ...base, aliases: ["ab", "c"] };
    const cur: CodexSnapshot = { ...base, aliases: ["a", "bc"] };
    const changes = computeCodexDiff(b, cur);
    expect(changes.some((c) => c.field === "aliases")).toBe(true);
  });

  it("ignores whitespace-only differences (normalized)", () => {
    const cur: CodexSnapshot = { ...base, summary: "15歳の少女。 黒髪。 " };
    expect(computeCodexDiff(base, cur)).toEqual([]);
  });

  it("with null baseline (first run) emits whole non-empty entry as changes", () => {
    const changes = computeCodexDiff(null, base);
    // name + summary + content + 2 details = 5 changes, all old=""
    expect(changes.every((c) => c.old === "")).toBe(true);
    expect(changes.some((c) => c.field === "name" && c.new === "アリス")).toBe(
      true,
    );
    expect(changes.some((c) => c.field === "detail" && c.name === "年齢")).toBe(
      true,
    );
    // empty aliases/fields are not emitted
    const empty: CodexSnapshot = {
      name: "",
      aliases: [],
      summary: "",
      contentPlain: "",
      details: [],
    };
    expect(computeCodexDiff(null, empty)).toEqual([]);
  });

  it("base diff is unaffected by absent phases (back-compat)", () => {
    // phases undefined on both sides → identical → no changes.
    expect(computeCodexDiff(base, { ...base })).toEqual([]);
  });

  it("detects a phase-specific content override edit", () => {
    const b: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: null,
          contentPlain: "都に出る。",
          details: [],
        },
      ],
    };
    const cur: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: null,
          contentPlain: "王都の騎士団に所属する。",
          details: [],
        },
      ],
    };
    const changes = computeCodexDiff(b, cur);
    expect(changes).toContainEqual({
      field: "phase_content",
      name: null,
      phase: "第2部",
      old: "都に出る。",
      new: "王都の騎士団に所属する。",
    });
    // base fields untouched → only the phase change is emitted.
    expect(changes).toHaveLength(1);
  });

  it("detects a phase summary override and phase detail override edit", () => {
    const b: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: "17歳。",
          contentPlain: null,
          details: [{ name: "所属", value: "なし" }],
        },
      ],
    };
    const cur: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: "18歳。隊長。",
          contentPlain: null,
          details: [{ name: "所属", value: "騎士団" }],
        },
      ],
    };
    const changes = computeCodexDiff(b, cur);
    expect(changes).toContainEqual({
      field: "phase_summary",
      name: null,
      phase: "第2部",
      old: "17歳。",
      new: "18歳。隊長。",
    });
    expect(changes).toContainEqual({
      field: "phase_detail",
      name: "所属",
      phase: "第2部",
      old: "なし",
      new: "騎士団",
    });
  });

  it("treats a newly added phase override (null baseline phase) as old=''", () => {
    const b: CodexSnapshot = { ...base, phases: [] };
    const cur: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: null,
          contentPlain: "騎士団に入る。",
          details: [],
        },
      ],
    };
    const changes = computeCodexDiff(b, cur);
    expect(changes).toContainEqual({
      field: "phase_content",
      name: null,
      phase: "第2部",
      old: "",
      new: "騎士団に入る。",
    });
  });

  it("emits nothing for a phase that has no overrides", () => {
    const b: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: null,
          contentPlain: null,
          details: [],
        },
      ],
    };
    const cur: CodexSnapshot = {
      ...base,
      phases: [
        {
          phaseId: "p1",
          label: "第2部",
          summary: null,
          contentPlain: null,
          details: [],
        },
      ],
    };
    expect(computeCodexDiff(b, cur)).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  it("renders detail changes as 'name: old → new'", () => {
    const s = summarizeChanges([
      { field: "detail", name: "年齢", old: "15", new: "17" },
    ]);
    expect(s).toContain("年齢");
    expect(s).toContain("15");
    expect(s).toContain("17");
    expect(s).toContain("→");
  });

  it("returns a non-empty label for non-detail fields", () => {
    const s = summarizeChanges([
      { field: "summary", name: null, old: "a", new: "b" },
    ]);
    expect(s.length).toBeGreaterThan(0);
  });

  it("renders empty change list as empty string", () => {
    expect(summarizeChanges([])).toBe("");
  });

  it("renders phase changes with the phase label", () => {
    const s = summarizeChanges([
      {
        field: "phase_content",
        name: null,
        phase: "第2部",
        old: "a",
        new: "b",
      },
      {
        field: "phase_detail",
        name: "所属",
        phase: "第2部",
        old: "なし",
        new: "騎士団",
      },
    ]);
    expect(s).toContain("第2部");
    expect(s).toContain("所属");
    expect(s).toContain("騎士団");
  });
});

describe("computeChangeId", () => {
  it("is stable for the same entry + changes", () => {
    const changes = [
      { field: "detail" as const, name: "年齢", old: "15", new: "17" },
    ];
    expect(computeChangeId("e1", changes)).toBe(computeChangeId("e1", changes));
  });

  it("differs when the change set differs", () => {
    const a = computeChangeId("e1", [
      { field: "detail", name: "年齢", old: "15", new: "17" },
    ]);
    const b = computeChangeId("e1", [
      { field: "detail", name: "年齢", old: "15", new: "18" },
    ]);
    expect(a).not.toBe(b);
  });

  it("differs across entries", () => {
    const changes = [
      { field: "summary" as const, name: null, old: "a", new: "b" },
    ];
    expect(computeChangeId("e1", changes)).not.toBe(
      computeChangeId("e2", changes),
    );
  });
});
