import { describe, it, expect } from "vitest";
import {
  checkInputsFingerprint,
  collectLoadedSceneTexts,
  mergeAgeCheckEvents,
  type EventForCheck,
} from "./useSeasonConflicts";

type E = { id: string; startTime: number | null };

describe("mergeAgeCheckEvents", () => {
  const events: E[] = [{ id: "e1", startTime: 10 }];
  const links = [{ sceneId: "sA", eventId: "e1" }];

  it("ageExtraEvents 未指定なら入力をそのまま返す（季節チェック影響なし）", () => {
    const r = mergeAgeCheckEvents(events, links, undefined);
    expect(r.ageEvents).toBe(events);
    expect(r.ageLinks).toBe(links);
  });

  it("空配列も入力そのまま", () => {
    const r = mergeAgeCheckEvents(events, links, []);
    expect(r.ageEvents).toBe(events);
    expect(r.ageLinks).toBe(links);
  });

  it("scene-event を足し、暗黙リンク(scene:<id> ↔ <id>)を張る", () => {
    const extra: E[] = [
      { id: "scene:sc1", startTime: 20 },
      { id: "scene:sc2", startTime: 30 },
    ];
    const r = mergeAgeCheckEvents(events, links, extra);
    expect(r.ageEvents.map((e) => e.id)).toEqual([
      "e1",
      "scene:sc1",
      "scene:sc2",
    ]);
    expect(r.ageLinks).toEqual([
      { sceneId: "sA", eventId: "e1" },
      { sceneId: "sc1", eventId: "scene:sc1" }, // 自分自身の本文を参照
      { sceneId: "sc2", eventId: "scene:sc2" },
    ]);
  });
});

describe("checkInputsFingerprint", () => {
  const base = (): EventForCheck[] => [
    { id: "e1", startTime: 10, primaryCodexId: "c1", kind: "generic" },
    { id: "e2", startTime: null, primaryCodexId: null, kind: "birth" },
  ];
  const links = [{ sceneId: "sA", eventId: "e1" }];

  it("チェックに効かないフィールド（title 等）や配列 identity では変わらない", () => {
    const a = checkInputsFingerprint(base(), links, []);
    const withTitle = base().map((e) => ({ ...e, title: "打鍵中…" }));
    const b = checkInputsFingerprint(withTitle, [...links], []);
    expect(b).toBe(a);
  });

  it("startTime / primaryCodexId / kind / リンク対 の変化では変わる", () => {
    const a = checkInputsFingerprint(base(), links, []);
    const moved = base();
    moved[0] = { ...moved[0], startTime: 11 };
    expect(checkInputsFingerprint(moved, links, [])).not.toBe(a);

    const pov = base();
    pov[0] = { ...pov[0], primaryCodexId: "c2" };
    expect(checkInputsFingerprint(pov, links, [])).not.toBe(a);

    const kind = base();
    kind[1] = { ...kind[1], kind: "death" };
    expect(checkInputsFingerprint(kind, links, [])).not.toBe(a);

    expect(
      checkInputsFingerprint(
        base(),
        [...links, { sceneId: "sB", eventId: "e2" }],
        [],
      ),
    ).not.toBe(a);
  });

  it("ageExtraEvents（scene-event）の増減・日付変化でも変わる", () => {
    const extra: EventForCheck[] = [
      { id: "scene:sc1", startTime: 20, primaryCodexId: "c1", kind: "generic" },
    ];
    const a = checkInputsFingerprint(base(), links, extra);
    expect(checkInputsFingerprint(base(), links, [])).not.toBe(a);
    const shifted = [{ ...extra[0], startTime: 21 }];
    expect(checkInputsFingerprint(base(), links, shifted)).not.toBe(a);
  });

  it("undefined と空配列の ageExtraEvents は同一視する", () => {
    expect(checkInputsFingerprint(base(), links, undefined)).toBe(
      checkInputsFingerprint(base(), links, []),
    );
  });

  it("セクション間（events / links）で似た内容が混ざっても衝突しない", () => {
    const a = checkInputsFingerprint([], links, []);
    const b = checkInputsFingerprint(
      [{ id: "sA", startTime: null, primaryCodexId: "e1", kind: "" }],
      [],
      [],
    );
    expect(a).not.toBe(b);
  });
});

describe("collectLoadedSceneTexts", () => {
  it("batch の成功行を plain text 化し、欠損行は空本文にする", () => {
    const m = collectLoadedSceneTexts(
      ["s1", "missing", "s2"],
      new Map([
        [
          "s1",
          JSON.stringify({
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "本文1" }] },
            ],
          }),
        ],
        [
          "s2",
          JSON.stringify({
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "本文2" }] },
            ],
          }),
        ],
      ]),
    );
    expect(m.get("s1")).toBe("本文1");
    expect(m.get("s2")).toBe("本文2");
    expect(m.get("missing")).toBe("");
    expect(m.size).toBe(3);
  });
});
