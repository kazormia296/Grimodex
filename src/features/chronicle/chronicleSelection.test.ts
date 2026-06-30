import { describe, expect, it } from "vitest";
import { nextSelection, type SelectionState } from "./chronicleSelection";

const ORDER = ["a", "b", "c", "d", "e"]; // 時間順
const single = (id: string): SelectionState => ({
  selectedEventId: id,
  selectedEventIds: [id],
});

describe("nextSelection", () => {
  it("修飾なし＝単一選択 [id]", () => {
    const r = nextSelection(
      single("a"),
      "c",
      { toggle: false, range: false },
      ORDER,
    );
    expect(r).toEqual({ ids: ["c"], primary: "c" });
  });

  it("toggle＝未選択を追加（プライマリ=追加 id）", () => {
    const r = nextSelection(
      single("a"),
      "c",
      { toggle: true, range: false },
      ORDER,
    );
    expect(r.ids).toEqual(["a", "c"]);
    expect(r.primary).toBe("c");
  });

  it("toggle＝選択済みを除去（プライマリ=残りの末尾）", () => {
    const cur: SelectionState = {
      selectedEventId: "c",
      selectedEventIds: ["a", "c"],
    };
    const r = nextSelection(cur, "c", { toggle: true, range: false }, ORDER);
    expect(r.ids).toEqual(["a"]);
    expect(r.primary).toBe("a");
  });

  it("toggle＝最後の1件を除去すると空＝primary null", () => {
    const r = nextSelection(
      single("a"),
      "a",
      { toggle: true, range: false },
      ORDER,
    );
    expect(r.ids).toEqual([]);
    expect(r.primary).toBeNull();
  });

  it("range＝アンカー〜id を時間順で区間選択（両端含む）", () => {
    const r = nextSelection(
      single("b"),
      "d",
      { toggle: false, range: true },
      ORDER,
    );
    expect(r.ids).toEqual(["b", "c", "d"]);
    expect(r.primary).toBe("d");
  });

  it("range＝アンカーが id より後でも昇順区間（向き非依存）", () => {
    const r = nextSelection(
      single("d"),
      "b",
      { toggle: false, range: true },
      ORDER,
    );
    expect(r.ids).toEqual(["b", "c", "d"]);
    expect(r.primary).toBe("b");
  });

  it("range＝アンカー無しなら単一選択にフォールバック", () => {
    const cur: SelectionState = { selectedEventId: null, selectedEventIds: [] };
    const r = nextSelection(cur, "c", { toggle: false, range: true }, ORDER);
    expect(r).toEqual({ ids: ["c"], primary: "c" });
  });
});
