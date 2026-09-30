import { describe, expect, it } from "vitest";
import { buildCodexRelationSemanticKey } from "./relationVocabulary";
import {
  buildExistingRelationCatalog,
  matchExistingCodexRelation,
} from "./existingRelationMatcher";

describe("matchExistingCodexRelation", () => {
  const semanticKey = buildCodexRelationSemanticKey({
    projectId: "p1",
    fromCodexId: "entry-a",
    toCodexId: "entry-b",
    relationType: "friend",
    directionality: "symmetric",
    forwardLabel: "友人",
    inverseLabel: "友人",
  });

  const catalog = buildExistingRelationCatalog([
    {
      id: "rel-1",
      fromCodexId: "entry-a",
      toCodexId: "entry-b",
      relationType: "friend",
      directionality: "symmetric",
      label: "友人",
      inverseLabel: "友人",
      semanticKey,
    },
  ]);

  it("marks exact semantic key hits as already-satisfied", () => {
    expect(matchExistingCodexRelation(semanticKey, catalog)).toEqual({
      status: "already-satisfied",
      existingRef: "R0001",
    });
  });

  it("returns unmatched for a different label", () => {
    const other = buildCodexRelationSemanticKey({
      projectId: "p1",
      fromCodexId: "entry-a",
      toCodexId: "entry-b",
      relationType: "enemy",
      directionality: "symmetric",
      forwardLabel: "敵",
      inverseLabel: "敵",
    });
    expect(matchExistingCodexRelation(other, catalog)).toEqual({
      status: "unmatched",
    });
  });

  it("ignores empty semantic keys and empty catalog rows", () => {
    expect(matchExistingCodexRelation("", catalog)).toEqual({
      status: "unmatched",
    });
    expect(matchExistingCodexRelation(semanticKey, [])).toEqual({
      status: "unmatched",
    });
    expect(
      buildExistingRelationCatalog([
        {
          id: "rel-empty",
          fromCodexId: "a",
          toCodexId: "b",
          relationType: "friend",
          directionality: "symmetric",
          label: "友人",
          inverseLabel: "友人",
          semanticKey: "",
        },
      ]),
    ).toEqual([]);
  });
});
