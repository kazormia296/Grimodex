import { describe, expect, it } from "vitest";

import scopeRelationPolicy from "../../../../policies/narrative/narrative-scope-relation-contract.json";
import {
  compareScopeRelation,
  composeScopeRelations,
  validateScopeOrder,
  type NarrativeScopeV2,
  type ScopeAxis,
  type ScopeComparisonBasis,
  type ScopeOrderOracle,
  type ScopeRelation,
  type ScopeRelationRegistry,
} from "./scopeRelation";

const anyAxes: NarrativeScopeV2 = {
  schemaVersion: 2,
  registryVersion: "narrative-scope/2",
  timeline: { kind: "any" },
  worldline: { kind: "any" },
  scene: { kind: "any" },
  viewpoint: { kind: "any" },
  knowledgeHolder: { kind: "any" },
  audience: { kind: "any" },
  narrativeLayer: { kind: "any" },
  storyTime: { kind: "any" },
  readingOrder: { kind: "any" },
};

function scopeWith(patch: Partial<NarrativeScopeV2>): NarrativeScopeV2 {
  return { ...anyAxes, ...patch };
}

function relationAxes(
  relation: ScopeRelation,
): Record<ScopeAxis, ScopeRelation> {
  return Object.fromEntries(
    Object.keys(anyAxes)
      .filter((key) => key !== "schemaVersion" && key !== "registryVersion")
      .map((axis) => [axis, relation]),
  ) as Record<ScopeAxis, ScopeRelation>;
}

const basis: ScopeComparisonBasis = {
  scopeRegistryVersion: "narrative-scope/2",
  storyTimeOrderRevision: "story-time/1",
  readingOrderRevision: "reading-order/1",
  worldlineRegistryRevision: "worldline/1",
  narrativeLayerRegistryRevision: "layer/1",
};

function orderedOracle(
  axis: ScopeOrderOracle["axis"],
  revisionToken: string,
  order: readonly string[],
): ScopeOrderOracle {
  return {
    axis,
    revisionToken,
    compare(leftRef, rightRef) {
      const left = order.indexOf(leftRef);
      const right = order.indexOf(rightRef);
      if (left === -1 || right === -1) return "unresolved";
      return left === right ? 0 : left < right ? -1 : 1;
    },
  };
}

const storyTimeOracle = orderedOracle("story-time", "story-time/1", [
  "story:1",
  "story:2",
  "story:3",
  "story:4",
  "story:5",
]);
const readingOrderOracle = orderedOracle("reading-order", "reading-order/1", [
  "read:1",
  "read:2",
  "read:3",
  "read:4",
  "read:5",
]);

describe("Narrative Scope Relation S2 contract", () => {
  it("executes every ratified basic relation fixture", () => {
    const fixtureById = new Map(
      scopeRelationPolicy.basicRelationFixtures.map((fixture) => [
        fixture.id,
        fixture,
      ]),
    );
    expect(fixtureById.get("any-vs-any-is-equal")?.expected).toBe("equal");
    expect(fixtureById.get("any-vs-exact-is-contains")?.expected).toBe(
      "contains",
    );

    const cases = [
      ["any-vs-any-is-equal", { kind: "any" }, { kind: "any" }],
      [
        "any-vs-exact-is-contains",
        { kind: "any" },
        { kind: "exact", ref: "scene:1" },
      ],
      [
        "any-vs-unresolved-is-contains",
        { kind: "any" },
        { kind: "unresolved", reason: "missing-reference" },
      ],
      [
        "unresolved-vs-any-is-contained-by",
        { kind: "unresolved", reason: "missing-reference" },
        { kind: "any" },
      ],
    ] as const;

    for (const [id, left, right] of cases) {
      const result = compareScopeRelation(
        scopeWith({ scene: left }),
        scopeWith({ scene: right }),
      );
      expect(result.relation, id).toBe(fixtureById.get(id)?.expected);
    }
  });

  it("does not treat an unresolved reason as identity, but accepts stable identity", () => {
    const sameReason = compareScopeRelation(
      scopeWith({ scene: { kind: "unresolved", reason: "ambiguous" } }),
      scopeWith({ scene: { kind: "unresolved", reason: "ambiguous" } }),
    );
    expect(sameReason.relation).toBe("unknown");
    expect(sameReason.basis).toBeNull();

    const sameConstraintId = compareScopeRelation(
      scopeWith({
        scene: { kind: "unresolved", reason: "ambiguous", constraintId: "c-1" },
      }),
      scopeWith({
        scene: {
          kind: "unresolved",
          reason: "missing-reference",
          constraintId: "c-1",
        },
      }),
    );
    expect(sameConstraintId.relation).toBe("equal");
    expect(sameConstraintId.oracleUsed).toBe(false);
    expect(sameConstraintId.basis).toBeNull();

    const sameRevision = compareScopeRelation(
      scopeWith({ scene: { kind: "unresolved", reason: "ambiguous" } }),
      scopeWith({ scene: { kind: "unresolved", reason: "missing-reference" } }),
      { scopeRevision: "scope-revision/1" },
    );
    expect(sameRevision.relation).toBe("equal");
  });

  it("keeps structural equality basis-free and requires Basis for Registry-derived equality", () => {
    const structural = compareScopeRelation(
      scopeWith({ scene: { kind: "exact", ref: "scene:1" } }),
      scopeWith({ scene: { kind: "exact", ref: "scene:1" } }),
    );
    expect(structural).toMatchObject({
      relation: "equal",
      oracleUsed: false,
      basis: null,
    });

    const registry: ScopeRelationRegistry = {
      scopeRegistryVersion: "narrative-scope/2",
      worldlineRevision: "worldline/1",
      compareReference: (_axis, leftRef, rightRef) =>
        leftRef === "worldline:a" && rightRef === "worldline:b"
          ? "equal"
          : "unresolved",
    };
    expect(() =>
      compareScopeRelation(
        scopeWith({ worldline: { kind: "exact", ref: "worldline:a" } }),
        scopeWith({ worldline: { kind: "exact", ref: "worldline:b" } }),
        { registry },
      ),
    ).toThrow(/basis/i);

    const derived = compareScopeRelation(
      scopeWith({ worldline: { kind: "exact", ref: "worldline:a" } }),
      scopeWith({ worldline: { kind: "exact", ref: "worldline:b" } }),
      { registry, basis },
    );
    expect(derived).toMatchObject({
      relation: "equal",
      oracleUsed: true,
      basis,
    });
  });

  it("uses independent revisioned order oracles and validates intervals", () => {
    expect(
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:3", inclusive: true },
          until: { ref: "story:2", inclusive: true },
        },
        storyTimeOracle,
      ),
    ).toEqual({ status: "invalid", reason: "reversed-interval" });
    expect(
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:2", inclusive: false },
          until: { ref: "story:2", inclusive: false },
        },
        storyTimeOracle,
      ),
    ).toEqual({ status: "invalid", reason: "empty-interval" });
    expect(
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:2", inclusive: true },
          until: { ref: "story:2", inclusive: false },
        },
        storyTimeOracle,
      ),
    ).toEqual({ status: "invalid", reason: "empty-interval" });
    expect(
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:2", inclusive: false },
          until: { ref: "story:2", inclusive: true },
        },
        storyTimeOracle,
      ),
    ).toEqual({ status: "invalid", reason: "empty-interval" });
    expect(
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:2", inclusive: true },
          until: { ref: "story:2", inclusive: true },
        },
        storyTimeOracle,
      ),
    ).toEqual({ status: "valid" });

    const structuralIntervals = compareScopeRelation(
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:a", inclusive: true },
          until: { ref: "story:b", inclusive: false },
        },
      }),
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:a", inclusive: true },
          until: { ref: "story:b", inclusive: false },
        },
      }),
    );
    expect(structuralIntervals.axes.storyTime).toBe("equal");
    expect(structuralIntervals).toMatchObject({
      oracleUsed: false,
      basis: null,
    });

    const result = compareScopeRelation(
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:1", inclusive: true },
          until: { ref: "story:3", inclusive: true },
        },
        readingOrder: {
          kind: "interval",
          from: { ref: "read:2", inclusive: true },
          until: { ref: "read:4", inclusive: true },
        },
      }),
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:2", inclusive: true },
          until: { ref: "story:4", inclusive: true },
        },
        readingOrder: {
          kind: "interval",
          from: { ref: "read:1", inclusive: true },
          until: { ref: "read:3", inclusive: true },
        },
      }),
      {
        orderOracles: {
          "story-time": storyTimeOracle,
          "reading-order": readingOrderOracle,
        },
        basis,
      },
    );
    expect(result.axes.storyTime).toBe("overlaps");
    expect(result.axes.readingOrder).toBe("overlaps");
    expect(result.relation).toBe("overlaps");
    expect(result.oracleUsed).toBe(true);
    expect(result.basis).toEqual(basis);
  });

  it("fails closed when an Order Oracle violates antisymmetry", () => {
    const contradictoryOracle = orderedOracle("story-time", "story-time/1", [
      "story:a",
      "story:b",
      "story:c",
      "story:d",
    ]);
    const oracle: ScopeOrderOracle = {
      ...contradictoryOracle,
      compare(leftRef, rightRef) {
        if (leftRef === rightRef) return 0;
        // Deliberately return the same direction for both ordered pairs.
        return -1;
      },
    };

    expect(() =>
      compareScopeRelation(
        scopeWith({
          storyTime: {
            kind: "interval",
            from: { ref: "story:a", inclusive: true },
            until: { ref: "story:c", inclusive: true },
          },
        }),
        scopeWith({
          storyTime: {
            kind: "interval",
            from: { ref: "story:b", inclusive: true },
            until: { ref: "story:d", inclusive: true },
          },
        }),
        { orderOracles: { "story-time": oracle }, basis },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "ScopeRelationContractError",
        code: "contradictory-proof",
      }),
    );
  });

  it("fails closed when an Order Oracle gives a nonzero identity result", () => {
    const oracle: ScopeOrderOracle = {
      axis: "story-time",
      revisionToken: "story-time/1",
      compare(leftRef, rightRef) {
        return leftRef === rightRef ? 1 : -1;
      },
    };

    expect(() =>
      validateScopeOrder(
        {
          kind: "interval",
          from: { ref: "story:a", inclusive: true },
          until: { ref: "story:b", inclusive: true },
        },
        oracle,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "ScopeRelationContractError",
        code: "invalid-order-oracle",
      }),
    );
  });

  it("fails closed when equality classes form a strict cycle", () => {
    const oracle: ScopeOrderOracle = {
      axis: "story-time",
      revisionToken: "story-time/1",
      compare(leftRef, rightRef) {
        if (leftRef === rightRef) return 0;
        if (leftRef === "story:a" && rightRef === "story:b") return 0;
        if (leftRef === "story:b" && rightRef === "story:a") return 0;
        if (leftRef === "story:c" && rightRef === "story:e") return -1;
        if (leftRef === "story:e" && rightRef === "story:c") return 1;
        if (leftRef === "story:a" && rightRef === "story:c") return -1;
        if (leftRef === "story:c" && rightRef === "story:a") return 1;
        if (leftRef === "story:b" && rightRef === "story:e") return 1;
        if (leftRef === "story:e" && rightRef === "story:b") return -1;
        return "unresolved";
      },
    };
    const left = scopeWith({
      storyTime: {
        kind: "interval",
        from: { ref: "story:a", inclusive: true },
        until: { ref: "story:b", inclusive: true },
      },
    });
    const right = scopeWith({
      storyTime: {
        kind: "interval",
        from: { ref: "story:c", inclusive: true },
        until: { ref: "story:e", inclusive: true },
      },
    });

    for (const [first, second] of [
      [left, right],
      [right, left],
    ] as const) {
      expect(() =>
        compareScopeRelation(first, second, {
          orderOracles: { "story-time": oracle },
          basis,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "ScopeRelationContractError",
          code: "contradictory-proof",
        }),
      );
    }
  });

  it("fails closed for the equality-class interval acceptance repro", () => {
    const oracle: ScopeOrderOracle = {
      axis: "story-time",
      revisionToken: "story-time/1",
      compare(leftRef, rightRef) {
        if (leftRef === rightRef) return 0;
        if (
          (leftRef === "story:a" && rightRef === "story:b") ||
          (leftRef === "story:b" && rightRef === "story:a")
        ) {
          return 0;
        }
        if (
          (leftRef === "story:c" && rightRef === "story:d") ||
          (leftRef === "story:d" && rightRef === "story:c")
        ) {
          return 0;
        }
        if (leftRef === "story:a" && rightRef === "story:c") return -1;
        if (leftRef === "story:c" && rightRef === "story:a") return 1;
        if (leftRef === "story:d" && rightRef === "story:b") return -1;
        if (leftRef === "story:b" && rightRef === "story:d") return 1;
        return "unresolved";
      },
    };
    const left = scopeWith({
      storyTime: {
        kind: "interval",
        from: { ref: "story:a", inclusive: true },
        until: { ref: "story:b", inclusive: true },
      },
    });
    const right = scopeWith({
      storyTime: {
        kind: "interval",
        from: { ref: "story:c", inclusive: true },
        until: { ref: "story:d", inclusive: true },
      },
    });

    for (const [first, second] of [
      [left, right],
      [right, left],
    ] as const) {
      expect(() =>
        compareScopeRelation(first, second, {
          orderOracles: { "story-time": oracle },
          basis,
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "ScopeRelationContractError",
          code: "contradictory-proof",
        }),
      );
    }
  });

  it("gives disjoint precedence over unknown and never invents overlap", () => {
    const registry: ScopeRelationRegistry = {
      scopeRegistryVersion: "narrative-scope/2",
      worldlineRevision: "worldline/1",
      compareReference: (_axis, leftRef, rightRef) =>
        leftRef === "worldline:a" && rightRef === "worldline:b"
          ? "disjoint"
          : "unresolved",
    };
    const result = compareScopeRelation(
      scopeWith({
        worldline: { kind: "exact", ref: "worldline:a" },
        scene: { kind: "unresolved", reason: "ambiguous" },
      }),
      scopeWith({
        worldline: { kind: "exact", ref: "worldline:b" },
        scene: { kind: "unresolved", reason: "ambiguous" },
      }),
      { registry, basis },
    );
    expect(result.axes.worldline).toBe("disjoint");
    expect(result.axes.scene).toBe("unknown");
    expect(result.relation).toBe("disjoint");

    const unresolvedIntervals = compareScopeRelation(
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:x", inclusive: true },
          until: { ref: "story:y", inclusive: true },
        },
      }),
      scopeWith({
        storyTime: {
          kind: "interval",
          from: { ref: "story:z", inclusive: true },
          until: { ref: "story:w", inclusive: true },
        },
      }),
      { orderOracles: { "story-time": storyTimeOracle }, basis },
    );
    expect(unresolvedIntervals.axes.storyTime).toBe("unknown");
    expect(unresolvedIntervals.relation).toBe("unknown");
  });

  it("fails closed for contradictory Registry proofs", () => {
    const registry: ScopeRelationRegistry = {
      scopeRegistryVersion: "narrative-scope/2",
      compareReference: () => ["equal", "disjoint"],
    };
    expect(() =>
      compareScopeRelation(
        scopeWith({ scene: { kind: "exact", ref: "scene:a" } }),
        scopeWith({ scene: { kind: "exact", ref: "scene:b" } }),
        { registry, basis },
      ),
    ).toThrow(/conflict/i);
  });

  it("composes the axis product according to the ratified precedence", () => {
    expect(
      composeScopeRelations(relationAxes("unknown"), { scene: "disjoint" }),
    ).toBe("disjoint");
    expect(composeScopeRelations(relationAxes("unknown"))).toBe("unknown");
    expect(composeScopeRelations(relationAxes("equal"))).toBe("equal");
    expect(
      composeScopeRelations({ ...relationAxes("equal"), scene: "contains" }),
    ).toBe("contains");
    expect(
      composeScopeRelations({
        ...relationAxes("equal"),
        scene: "contained-by",
      }),
    ).toBe("contained-by");
    expect(
      composeScopeRelations(
        { ...relationAxes("equal"), scene: "overlaps" },
        { scene: true },
      ),
    ).toBe("overlaps");
    expect(
      composeScopeRelations({ ...relationAxes("equal"), scene: "overlaps" }),
    ).toBe("unknown");
  });
});
