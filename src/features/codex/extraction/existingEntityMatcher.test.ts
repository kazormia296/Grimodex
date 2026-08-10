import { describe, expect, it } from "vitest";
import {
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
    const result = matchExistingEntity(
      { surfaces: ["ライカ"] },
      [entry({ ref: "K0001", name: "ライカ" })],
    );
    expect(result).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-name",
    });
  });

  it("marks multiple same-name entries as ambiguous", () => {
    const result = matchExistingEntity(
      { surfaces: ["ライカ"] },
      [
        entry({ ref: "K0001", name: "ライカ" }),
        entry({ ref: "K0002", name: "ライカ" }),
      ],
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.ref).sort()).toEqual([
      "K0001",
      "K0002",
    ]);
  });

  it("resolves a unique exact alias match", () => {
    const result = matchExistingEntity(
      { surfaces: ["灰"] },
      [entry({ ref: "K0001", name: "ライカ", aliases: ["灰"] })],
    );
    expect(result).toEqual({
      status: "resolved",
      ref: "K0001",
      method: "exact-alias",
    });
  });

  it("never auto-binds on honorific-strip alone", () => {
    const result = matchExistingEntity(
      { surfaces: ["ライカさん"] },
      [entry({ ref: "K0001", name: "ライカ" })],
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates[0]?.methods).toContain("honorific-strip");
    expect(result.candidates[0]?.methods).not.toContain("exact-name");
  });

  it("never auto-binds on prefix alone", () => {
    const result = matchExistingEntity(
      { surfaces: ["ライカ"] },
      [entry({ ref: "K0001", name: "ライカ隊長" })],
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates[0]?.methods).toContain("prefix");
  });

  it("returns none when nothing matches", () => {
    expect(
      matchExistingEntity(
        { surfaces: ["マルフーシャ"] },
        [entry({ ref: "K0001", name: "ライカ" })],
      ),
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
});
