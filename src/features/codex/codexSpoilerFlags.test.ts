import { describe, it, expect } from "vitest";
import { computeUnrevealedSecretForeshadows } from "./codexSpoilerFlags";
import type { ForeshadowRow } from "@/features/foreshadow/types";

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
const order = new Map<string, number>([
  ["s1", 0],
  ["s2", 1],
  ["s3", 2],
]);

describe("computeUnrevealedSecretForeshadows", () => {
  it("payoff 未設定の秘匿伏線は未開示として返す", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      order,
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });
  it("payoff が現在シーンより後なら未開示", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s3" })]]]),
      order,
      "s2",
    );
    expect(out.get("e1")).toEqual([{ id: "f1", title: "王の正体" }]);
  });
  it("payoff が現在シーン以前なら警告しない", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF({ payoffSceneId: "s1" })]]]),
      order,
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
      order,
      "s2",
    );
    expect(out.size).toBe(0);
  });
  it("currentSceneId が null なら空", () => {
    const out = computeUnrevealedSecretForeshadows(
      new Map([["e1", [makeF()]]]),
      order,
      null,
    );
    expect(out.size).toBe(0);
  });
});
