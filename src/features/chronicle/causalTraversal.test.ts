import { describe, it, expect } from "vitest";
import {
  connectedCausalChain,
  directCauses,
  directEffects,
} from "./causalTraversal";

type Rel = { causeId: string; effectId: string };

// A → B → C → D の直鎖 ＋ A → B'（A から分岐）＋ B → X（B から分岐）
const REL: Rel[] = [
  { causeId: "A", effectId: "B" },
  { causeId: "B", effectId: "C" },
  { causeId: "C", effectId: "D" },
  { causeId: "A", effectId: "B2" },
  { causeId: "B", effectId: "X" },
];

const ids = (s: Set<string>) => [...s].sort();

describe("connectedCausalChain", () => {
  it("直鎖の中間ノードは全世代（祖先＋子孫）を返す", () => {
    // C の祖先=B,A / 子孫=D。B の別分岐 X や A の別分岐 B2 は含めない。
    expect(ids(connectedCausalChain("C", REL))).toEqual(["A", "B", "C", "D"]);
  });

  it("子孫方向の分岐は全て含む（B の子孫 = C,D,X）", () => {
    // B の祖先=A / 子孫=C,D,X（下方向の分岐は全て consequences）。
    expect(ids(connectedCausalChain("B", REL))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "X",
    ]);
  });

  it("祖先方向で兄弟の子ツリー(B2)は含めない", () => {
    // B の祖先は A のみ。A の別の effect B2（B の兄弟）は含めない。
    expect(connectedCausalChain("B", REL).has("B2")).toBe(false);
  });

  it("関係の無いノードは自分だけ（size=1 → dim しない判定に使える）", () => {
    expect(ids(connectedCausalChain("Z", REL))).toEqual(["Z"]);
  });

  it("循環でも無限ループしない", () => {
    const cyc: Rel[] = [
      { causeId: "P", effectId: "Q" },
      { causeId: "Q", effectId: "P" },
    ];
    expect(ids(connectedCausalChain("P", cyc))).toEqual(["P", "Q"]);
  });
});

describe("directCauses / directEffects（1世代のみ・複数可）", () => {
  it("directCauses は直接の原因のみ（1世代上）", () => {
    expect(directCauses("C", REL).sort()).toEqual(["B"]);
    expect(directCauses("B", REL).sort()).toEqual(["A"]);
    expect(directCauses("A", REL)).toEqual([]);
  });

  it("directEffects は直接の結果のみ（1世代下・分岐は全部）", () => {
    expect(directEffects("A", REL).sort()).toEqual(["B", "B2"]);
    expect(directEffects("B", REL).sort()).toEqual(["C", "X"]);
    expect(directEffects("D", REL)).toEqual([]);
  });
});
