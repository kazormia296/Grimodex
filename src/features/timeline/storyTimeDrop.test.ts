import { describe, expect, it } from "vitest";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { planTiedStoryTimeDrop } from "./storyTimeDrop";

type Scene = { id: string; storyTimeOrder: string | null };

/** "id:値" の並びを、表示順の場面にする。 */
const scenes = (...spec: string[]): Scene[] =>
  spec.map((item) => {
    const [id, order] = item.split(":");
    return { id: id!, storyTimeOrder: order ?? null };
  });

/** 作中時間の軸の表示順（同じ値は元の並びのまま）。 */
const shown = (all: Scene[]) =>
  all
    .filter((scene) => scene.storyTimeOrder !== null)
    .sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!))
    .map((scene) => scene.id);

describe("planTiedStoryTimeDrop", () => {
  it.each([
    ["前から来る", scenes("m:a0", "s1:a1", "s2:a1", "s3:a1"), "s2"],
    ["後ろから来る", scenes("s1:a1", "s2:a1", "s3:a1", "m:a2"), "s2"],
    ["同じ値の中で後ろへ", scenes("s1:a1", "m:a1", "s2:a1", "s3:a1"), "s3"],
    ["同じ値の中で前へ", scenes("s1:a1", "s2:a1", "m:a1", "s3:a2"), "s2"],
    ["後ろに別の値がある", scenes("s1:a1", "s2:a1", "s3:a2", "m:a3"), "s2"],
    ["中ほど", scenes("s1:a1", "s2:a1", "s3:a1", "s4:a1", "m:a2"), "s3"],
  ])(
    "%s：どこで止まっても、他の場面の順番は変わらない",
    (_label, before, next) => {
      const writes = planTiedStoryTimeDrop(before, "m", next);
      expect(writes.at(-1)?.id).toBe("m");

      const others = shown(before).filter((id) => id !== "m");
      const expected = [...others];
      expected.splice(others.indexOf(next), 0, "m");

      const state = before.map((scene) => ({ ...scene }));
      const rest = () => shown(state).filter((id) => id !== "m");
      for (const write of writes) {
        state.find((scene) => scene.id === write.id)!.storyTimeOrder =
          write.order;
        expect(rest()).toEqual(shown(before).filter((id) => id !== "m"));
        // 落とした場面は、元の位置か落とした位置のどちらかにある。
        expect([shown(before), expected]).toContainEqual(shown(state));
      }
      expect(shown(state)).toEqual(expected);

      // 落とした位置より前の場面は書かない。
      expect(writes.slice(0, -1).map((write) => write.id)).not.toContain(
        expected[0],
      );
      // 振り直した場面どうしは同じ値のまま。
      expect(
        new Set(writes.slice(0, -1).map((write) => write.order)).size,
      ).toBeLessThanOrEqual(1);
    },
  );

  it("未配置の場面を同じ値の間に置ける", () => {
    const before = scenes("s1:a1", "s2:a1");
    const writes = planTiedStoryTimeDrop(before, "m", "s2");
    expect(writes.map((write) => write.id)).toEqual(["s2", "m"]);
    const [s2, m] = writes;
    expect(cmpKeys("a1", m!.order)).toBe(-1);
    expect(cmpKeys(m!.order, s2!.order)).toBe(-1);
  });

  it("順番が変わらない落とし込みは何も書かない", () => {
    const before = scenes("s1:a1", "m:a1", "s2:a1");
    expect(planTiedStoryTimeDrop(before, "m", "s2")).toEqual([]);
  });

  it("読めない値があれば例外を投げ、書き込みを返さない", () => {
    const bad = "a2000000000000";
    expect(() =>
      planTiedStoryTimeDrop(scenes("s1:a1", "s2:a1", `s3:${bad}`), "m", "s2"),
    ).toThrow();
  });
});
