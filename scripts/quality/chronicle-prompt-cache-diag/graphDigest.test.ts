import { describe, expect, it } from "vitest";
import type { NarrativeActualGraph } from "@/features/narrative-extraction/eval/types";
import { differingParts, enumHistograms, graphDigest } from "./graphDigest";

const obs = (id: string, actuality: string, key?: string) => ({
  id,
  semanticKey: key ?? `production-observation:${id}`,
  dimensions: {
    actuality: { status: "observed" as const, value: actuality },
  },
});
const graph = (
  ...observations: ReturnType<typeof obs>[]
): NarrativeActualGraph => ({
  observations,
});

describe("graphDigest", () => {
  it("id・並び順に依存せず、意味 field が同じなら同じ digest", async () => {
    const a = await graphDigest(
      graph(obs("x1", "actual"), obs("x2", "rumored")),
      [],
    );
    const b = await graphDigest(
      graph(obs("y9", "rumored"), obs("y8", "actual")),
      [],
    );
    expect(a.digest).toBe(b.digest);
    expect(differingParts([a.parts, b.parts])).toEqual([]);
  });

  it("意味 field が違えば digest が違い、違う部分を特定できる", async () => {
    const a = await graphDigest(graph(obs("x1", "actual")), []);
    const b = await graphDigest(graph(obs("x1", "rumored")), []);
    expect(a.digest).not.toBe(b.digest);
    expect(differingParts([a.parts, b.parts])).toEqual(["dimension:actuality"]);
  });

  it("仮説の significance の違いは hypotheses の部分だけに出る", async () => {
    const hypothesis = (significance: string) => ({
      actuality: "actual",
      significance,
      observationRefs: ["o"],
    });
    const a = await graphDigest(graph(obs("x1", "actual")), [
      hypothesis("major"),
    ]);
    const b = await graphDigest(graph(obs("x1", "actual")), [
      hypothesis("minor"),
    ]);
    expect(differingParts([a.parts, b.parts])).toEqual(["hypotheses"]);
  });
});

describe("enumHistograms", () => {
  it("列挙値の件数分布を返す", () => {
    expect(
      enumHistograms(
        graph(obs("a", "actual"), obs("b", "actual"), obs("c", "rumored")),
      ).actuality,
    ).toEqual({ actual: 2, rumored: 1 });
  });
});
