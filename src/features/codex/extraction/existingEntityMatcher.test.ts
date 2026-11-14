import { describe, expect, it } from "vitest";
import {
  inspectExactEntityMatch,
  matchExistingEntity,
  type ExistingEntityCatalogRecord,
} from "./existingEntityMatcher";

function entry(
  overrides: Partial<ExistingEntityCatalogRecord> &
    Pick<ExistingEntityCatalogRecord, "ref" | "name">,
): ExistingEntityCatalogRecord {
  return {
    sourceKey: `db:${overrides.ref}`,
    aliases: [],
    typeRef: "T0001",
    expectedVersion: 1,
    ...overrides,
  };
}

describe("matchExistingEntity", () => {
  it("resolves a unique exact name match", () => {
    const result = matchExistingEntity({ surfaces: ["ライカ"] }, [
      entry({ ref: "K0001", name: "ライカ" }),
    ]);
    expect(result).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-name",
    });
  });

  it("marks multiple same-name entries as ambiguous", () => {
    const result = matchExistingEntity({ surfaces: ["ライカ"] }, [
      entry({ ref: "K0001", name: "ライカ" }),
      entry({ ref: "K0002", name: "ライカ" }),
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.ref).sort()).toEqual([
      "K0001",
      "K0002",
    ]);
  });

  it("resolves a unique exact alias match", () => {
    const result = matchExistingEntity({ surfaces: ["灰"] }, [
      entry({ ref: "K0001", name: "ライカ", aliases: ["灰"] }),
    ]);
    expect(result).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-alias",
    });
  });

  it("never auto-binds on honorific-strip alone", () => {
    const result = matchExistingEntity({ surfaces: ["ライカさん"] }, [
      entry({ ref: "K0001", name: "ライカ" }),
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates[0]?.methods).toContain("honorific-strip");
    expect(result.candidates[0]?.methods).not.toContain("exact-name");
  });

  it("never auto-binds on prefix alone", () => {
    const result = matchExistingEntity({ surfaces: ["ライカ"] }, [
      entry({ ref: "K0001", name: "ライカ隊長" }),
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates[0]?.methods).toContain("prefix");
  });

  it("returns none when nothing matches", () => {
    expect(
      matchExistingEntity({ surfaces: ["マルフーシャ"] }, [
        entry({ ref: "K0001", name: "ライカ" }),
      ]),
    ).toEqual({ status: "none" });
  });

  it("resolves unique explicit-identity refs", () => {
    const result = matchExistingEntity(
      { surfaces: ["彼女"], explicitIdentityRefs: ["K0001"] },
      [entry({ ref: "K0001", name: "ライカ" })],
    );
    expect(result).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "explicit-identity",
    });
  });

  describe("relational terms (kinship / second / third person)", () => {
    it("does not strip honorifics from a relational term to reach a roster name", () => {
      const result = matchExistingEntity({ surfaces: ["姉ちゃん"] }, [
        entry({ ref: "K0001", name: "姉" }),
      ]);
      expect(result).toEqual({ status: "none" });
    });

    it("emits no prefix or substring candidates for a relational term", () => {
      expect(
        matchExistingEntity({ surfaces: ["おじいさん"] }, [
          entry({ ref: "K0001", name: "ライカ", aliases: ["じい"] }),
        ]),
      ).toEqual({ status: "none" });
      expect(
        matchExistingEntity({ surfaces: ["彼女"] }, [
          entry({ ref: "K0001", name: "彼女の影" }),
        ]),
      ).toEqual({ status: "none" });
    });

    it("still resolves a relational term the author put in a name or alias", () => {
      expect(
        matchExistingEntity({ surfaces: ["姉ちゃん"] }, [
          entry({ ref: "K0001", name: "ライカ", aliases: ["姉ちゃん"] }),
        ]),
      ).toEqual({ status: "resolved", ref: "K0001", method: "exact-alias" });
      expect(
        matchExistingEntity({ surfaces: ["ダンナ"] }, [
          entry({ ref: "K0002", name: "ダンナ" }),
        ]),
      ).toEqual({ status: "resolved", ref: "K0002", method: "exact-name" });
    });

    it("keeps ambiguous for duplicate exact hits of a relational term", () => {
      const result = matchExistingEntity({ surfaces: ["姉ちゃん"] }, [
        entry({ ref: "K0001", name: "ライカ", aliases: ["姉ちゃん"] }),
        entry({ ref: "K0002", name: "ベルカ", aliases: ["姉ちゃん"] }),
      ]);
      expect(result.status).toBe("ambiguous");
    });

    it("narrows to exact only per surface when AI-style input mixes a relational term and an ordinary one (shared by AI resolution and clustering)", () => {
      const catalog = [entry({ ref: "K0001", name: "ライカ" })];
      expect(
        matchExistingEntity({ surfaces: ["姉ちゃん", "ライカ"] }, catalog),
      ).toEqual({ status: "resolved", ref: "K0001", method: "exact-name" });
      expect(
        matchExistingEntity({ surfaces: ["姉ちゃん"] }, [
          entry({ ref: "K0002", name: "姉ちゃんの影" }),
        ]),
      ).toEqual({ status: "none" });
    });

    it("still strips ordinary honorifics from a non-relational surface", () => {
      const result = matchExistingEntity({ surfaces: ["ライカさん"] }, [
        entry({ ref: "K0001", name: "ライカ" }),
      ]);
      expect(result.status).toBe("ambiguous");
      if (result.status !== "ambiguous") return;
      expect(result.candidates[0]?.methods).toContain("honorific-strip");
    });
  });
});

describe("inspectExactEntityMatch", () => {
  it("名前が A・別名が B に当たる表記は、resolved は A のまま、該当は 2 Entry になる", () => {
    const catalog = [
      entry({ ref: "K0001", name: "ミナト" }),
      entry({ ref: "K0002", name: "リオ", aliases: ["ミナト"] }),
    ];
    expect(matchExistingEntity({ surfaces: ["ミナト"] }, catalog)).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-name",
    });
    expect(inspectExactEntityMatch("ミナト", catalog).exactRefs).toEqual([
      "K0001",
      "K0002",
    ]);
  });

  it("名前と別名の両方に同じ Entry で当たっても 1 Entry と数える", () => {
    const result = inspectExactEntityMatch("ミナト", [
      entry({ ref: "K0001", name: "ミナト", aliases: ["ミナト"] }),
    ]);
    expect(result.exactRefs).toEqual(["K0001"]);
    expect(result.partialOtherRefs).toEqual([]);
  });

  it("姓だけの Entry と姓名の Entry がある名簿では、姓名の Entry を部分一致の他 Entry に出す", () => {
    const catalog = [
      entry({ ref: "K0001", name: "ミナト" }),
      entry({ ref: "K0002", name: "ミナトソウ" }),
    ];
    // resolved は姓だけの Entry に完全一致のまま（挙動は変えない）。
    expect(matchExistingEntity({ surfaces: ["ミナト"] }, catalog)).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-name",
    });
    const result = inspectExactEntityMatch("ミナト", catalog);
    expect(result.exactRefs).toEqual(["K0001"]);
    expect(result.partialOtherRefs).toEqual(["K0002"]);
  });

  it("敬称除去で当たる別の Entry も部分一致に数える", () => {
    const result = inspectExactEntityMatch("ミナト", [
      entry({ ref: "K0001", name: "ミナト" }),
      entry({ ref: "K0002", name: "ミナトさん" }),
    ]);
    expect(result.exactRefs).toEqual(["K0001"]);
    expect(result.partialOtherRefs).toEqual(["K0002"]);
  });

  it("他に何も当たらなければ部分一致は空", () => {
    const result = inspectExactEntityMatch("ミナト", [
      entry({ ref: "K0001", name: "ミナト" }),
      entry({ ref: "K0002", name: "ハル" }),
    ]);
    expect(result).toEqual({ exactRefs: ["K0001"], partialOtherRefs: [] });
  });

  it("呼び名の語でも、完全一致の狭めはかけず部分一致の他 Entry を見る", () => {
    const result = inspectExactEntityMatch("姉ちゃん", [
      entry({ ref: "K0001", name: "姉ちゃん" }),
      entry({ ref: "K0002", name: "姉ちゃんの家" }),
    ]);
    expect(result.exactRefs).toEqual(["K0001"]);
    expect(result.partialOtherRefs).toEqual(["K0002"]);
  });

  it("空の表記は何にも当たらない", () => {
    expect(
      inspectExactEntityMatch("  ", [entry({ ref: "K0001", name: "" })]),
    ).toEqual({ exactRefs: [], partialOtherRefs: [] });
  });
});
