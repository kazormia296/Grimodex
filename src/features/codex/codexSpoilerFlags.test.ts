import { describe, it, expect } from "vitest";
import { computeUnrevealedSecretForeshadows } from "./codexSpoilerFlags";
import type { ForeshadowRow } from "@/features/foreshadow/types";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";

function makeF(over: Partial<ForeshadowRow> = {}): ForeshadowRow {
  return {
    id: "f1",
    projectId: "p1",
    title: "王の正体",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    secret: true,
    loadBearing: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}
function node(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null,
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
const index = buildSceneTimeIndex([
  node("s1", "a0", null),
  node("s2", "a1", null),
  node("s3", "a2", null),
]);

describe("computeUnrevealedSecretForeshadows", () => {
  it("payoff 未設定の秘匿伏線は未開示として返す", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      index,
      "reading",
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });
  it("payoff が現在シーンより後なら未開示", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s3" })]]]),
      index,
      "reading",
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });
  it("payoff が現在シーン以前なら警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s1" })]]]),
      index,
      "reading",
      "s2",
    );
    expect(out.has("e1")).toBe(false);
  });
  it("secret=false / abandoned=true は警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([
        ["e1", [makeF({ secret: false })]],
        ["e2", [makeF({ id: "f2", abandoned: true })]],
      ]),
      index,
      "reading",
      "s2",
    );
    expect(out.size).toBe(0);
  });
  it("currentSceneId が null なら空", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      index,
      "reading",
      null,
    );
    expect(out.size).toBe(0);
  });
  it("payoffConfirmed=true で payoffSceneId=null（orphan_payoff）は警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([
        ["e1", [makeF({ payoffConfirmed: true, payoffSceneId: null })]],
      ]),
      index,
      "reading",
      "s2",
    );
    expect(out.has("e1")).toBe(false);
  });
  it("payoff が現在シーンと同一なら警告しない（境界）", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s2" })]]]),
      index,
      "reading",
      "s2",
    );
    expect(out.has("e1")).toBe(false);
  });
  it("payoff シーンが順序に無い（削除等）なら未開示扱い", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "gone" })]]]),
      index,
      "reading",
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });

  it("story: unrelated な先頭未設定 scene が valid current/payoff の未来判定を reading へ落とさない", () => {
    const index = buildSceneTimeIndex([
      node("unrelated", "a0", null),
      // reading では payoff が先だが、story では current より未来。
      node("payoff", "a1", "z0"),
      node("current", "a2", "a0"),
    ]);

    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "payoff" })]]]),
      index,
      "story",
      "current",
    );

    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });
});
