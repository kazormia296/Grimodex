import { describe, expect, it } from "vitest";
import fixtureManifest from "../../../evals/nir1-packing/fixtures.json";
import {
  runNir1CacheBindingMutations,
  runNir1PackingEvaluation,
} from "../../../scripts/quality/nir1-packing/runner.mjs";
import {
  adaptNir1FixtureQualifiedInput,
  createNir1ContextPlan,
  createNir1PackingBaseline,
  isNir1CacheBindingCurrent,
  replanNir1Context,
  selectNir1RawPriorityBaseline,
  selectNir1PackingItems,
  type Nir1PackingBudget,
  type Nir1PackingItem,
  type Nir1CacheBinding,
  type Nir1FixtureA2CurrentReaderOutput,
} from "./nir1Packing";

const budget: Nir1PackingBudget = Object.freeze({
  contextWindowTokens: 64,
  systemTokens: 8,
  historyTokens: 4,
  toolTokens: 4,
  responseReservationTokens: 8,
});

const atomicItems: readonly Nir1PackingItem[] = Object.freeze([
  { id: "raw", kind: "raw", text: "Raw text", tokens: 2 },
  {
    id: "statement",
    kind: "accepted-ir",
    atomicGroup: "g",
    atomicPart: "statement",
    text: "Statement",
    tokens: 2,
  },
  {
    id: "negation",
    kind: "accepted-ir",
    atomicGroup: "g",
    atomicPart: "negation",
    text: "Negation",
    tokens: 2,
  },
  {
    id: "attribution",
    kind: "accepted-ir",
    atomicGroup: "g",
    atomicPart: "attribution",
    text: "Attribution",
    tokens: 2,
  },
  {
    id: "evidence",
    kind: "accepted-ir",
    atomicGroup: "g",
    atomicPart: "evidence",
    text: "Evidence",
    tokens: 2,
  },
  {
    id: "qualification",
    kind: "accepted-ir",
    atomicGroup: "g",
    atomicPart: "qualification",
    text: "human-approved",
    tokens: 1,
  },
]);

function currentReader(id = "test"): Nir1FixtureA2CurrentReaderOutput {
  return {
    source: "fixture-only-a2-current-reader",
    status: "current",
    decision: "approved",
    revisionId: `revision:${id}`,
    materialBasisDigest: `material:${id}`,
    sourceKey: `source:${id}`,
    sourceRevisionToken: `source-revision:${id}`,
    dependencyId: `dependency:${id}`,
    evidenceRef: `evidence:${id}`,
    evidenceQuoteDigest: `quote:${id}`,
    freshness: {
      semanticEpochId: `epoch:${id}`,
      dependencySetDigest: `dependencies:${id}`,
      declarationSetId: `declaration:${id}`,
      declarationSetDigest: `declarations:${id}`,
    },
    decisionId: `decision:${id}`,
  };
}

function fixtureItems(
  testCase: {
    qualificationRef: string;
    input: Array<Record<string, unknown>>;
  },
  outputs: Record<string, Nir1FixtureA2CurrentReaderOutput>,
): Nir1PackingItem[] {
  return testCase.input.map((raw) => {
    if (raw.kind !== "accepted-ir" && raw.kind !== "graph-evidence") {
      return raw as unknown as Nir1PackingItem;
    }
    const { qualificationRef, ...item } = raw;
    const reader =
      outputs[
        (qualificationRef as string | undefined) ?? testCase.qualificationRef
      ];
    try {
      return adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: item as unknown as Nir1PackingItem,
        reader,
      });
    } catch {
      return item as unknown as Nir1PackingItem;
    }
  });
}

const qualifiedAtomicItems: readonly Nir1PackingItem[] = Object.freeze(
  atomicItems.map((item) =>
    item.kind === "raw"
      ? item
      : adaptNir1FixtureQualifiedInput({
          source: "fixture-only-a2-adapter",
          item,
          reader: currentReader(),
        }),
  ),
);

function runFixtureEvaluation() {
  const outputs = fixtureManifest.execution
    .qualificationOutputs as unknown as Record<
    string,
    Nir1FixtureA2CurrentReaderOutput
  >;
  return runNir1PackingEvaluation(fixtureManifest, {
    baseline: (testCase) => {
      const items = fixtureItems(testCase, outputs);
      const baseline = createNir1PackingBaseline({
        budget: fixtureManifest.execution.budget,
        items,
      });
      return selectNir1RawPriorityBaseline({
        budget: fixtureManifest.execution.budget,
        items,
        baseline,
      });
    },
    candidate: (testCase) => {
      const items = fixtureItems(testCase, outputs);
      const baseline = createNir1PackingBaseline({
        budget: fixtureManifest.execution.budget,
        items,
      });
      return selectNir1PackingItems({
        budget: fixtureManifest.execution.budget,
        items,
        baseline,
        qualificationMode: "fixture",
      });
    },
  });
}

describe("NIR-1 D1 packing", () => {
  it("runs every isolated P-01..P-12 fixture through both arms and the scorer", () => {
    const manifest = fixtureManifest as unknown as {
      cases: Array<{
        caseId: string;
        qualificationRef: string;
        input: Array<Record<string, unknown>>;
        expected: { selectedIds: string[]; prohibitedIds: string[] };
      }>;
    };
    expect(manifest.cases).toHaveLength(12);
    const evaluation = runFixtureEvaluation();
    expect(evaluation.results).toHaveLength(12);
    expect(evaluation.score.status).toBe("passed");
    const cacheMutations = runNir1CacheBindingMutations(
      fixtureManifest,
      isNir1CacheBindingCurrent,
      ({ testCase, cachedBinding, currentBinding }) => {
        if (testCase.caseId !== "P-10")
          throw new Error("P-10 mutation callback received another case");
        const outputs = fixtureManifest.execution
          .qualificationOutputs as unknown as Record<
          string,
          Nir1FixtureA2CurrentReaderOutput
        >;
        const staleItems = fixtureItems(testCase, outputs);
        const currentReaderOutput = currentReader("p10-requalified");
        const currentItems = staleItems.map((item) => {
          if (item.kind === "raw") return item;
          const { qualificationProof: _qualificationProof, ...unqualified } =
            item;
          return adaptNir1FixtureQualifiedInput({
            source: "fixture-only-a2-adapter",
            item: {
              ...unqualified,
              text: `Requalified ${item.text}`,
            },
            reader: currentReaderOutput,
          });
        });
        const requestId = "P-10-cache-replan";
        const cachedPlan = createNir1ContextPlan({
          budget: fixtureManifest.execution.budget,
          items: staleItems,
          requestId,
          binding: cachedBinding as Nir1CacheBinding,
          qualificationMode: "fixture",
        });
        const plan = replanNir1Context({
          budget: fixtureManifest.execution.budget,
          items: currentItems,
          requestId,
          binding: currentBinding as Nir1CacheBinding,
          cachedPlan,
          qualificationMode: "fixture",
        });
        const staleById = new Map(
          staleItems
            .filter((item) => item.kind !== "raw")
            .map((item) => [item.id, item.text]),
        );
        const currentById = new Map(
          currentItems.map((item) => [item.id, item]),
        );
        const validMaterialRetained =
          plan.selectedItems.length === currentItems.length &&
          plan.selectedItems.every((item) => {
            const current = currentById.get(item.id);
            return (
              current?.text === item.text &&
              (item.kind === "raw" ||
                item.qualificationProof?.reader.revisionId ===
                  "revision:p10-requalified")
            );
          });
        const staleMaterialPresent = plan.selectedItems.some(
          (item) => staleById.get(item.id) === item.text,
        );
        const usedTokens = plan.cache.selectedItems.reduce(
          (total, item) => total + item.payload.tokens,
          0,
        );
        return {
          cachedPlan,
          plan,
          reused: plan === cachedPlan,
          staleMaterialPresent,
          validMaterialRetained,
          usedTokens,
        };
      },
    );
    expect(cacheMutations).toHaveLength(6);
    expect(cacheMutations.every((mutation) => mutation.current === false)).toBe(
      true,
    );
    for (const [index, testCase] of manifest.cases.entries()) {
      const result = evaluation.results[index]?.result?.candidate;
      expect(result?.selectedIds, testCase.caseId).toEqual(
        testCase.expected.selectedIds,
      );
      for (const id of testCase.expected.prohibitedIds) {
        expect(
          result?.selectedIds,
          `${testCase.caseId} prohibited ${id}`,
        ).not.toContain(id);
      }
    }
  });

  it("derives P-12 improvement from exact measured arm outputs", () => {
    const evaluation = runFixtureEvaluation();
    expect(evaluation.results).toHaveLength(12);
    expect(evaluation.score.status).toBe("passed");
    const p12 = evaluation.results.at(-1)?.result;
    expect(p12?.baseline.usedTokens).toBe(35);
    expect(p12?.candidate.usedTokens).toBe(40);
    expect(evaluation.score.cases.at(-1)).toMatchObject({
      improvementStatus: "passed",
      status: "passed",
    });
  });

  it("freezes the existing Raw-priority baseline before candidate selection", () => {
    const baseline = createNir1PackingBaseline({ budget, items: atomicItems });
    expect(Object.isFrozen(baseline.items)).toBe(true);
    expect(baseline.mapping).toEqual([
      { id: "raw", kind: "raw" },
      { id: "statement", kind: "accepted-ir" },
      { id: "negation", kind: "accepted-ir" },
      { id: "attribution", kind: "accepted-ir" },
      { id: "evidence", kind: "accepted-ir" },
      { id: "qualification", kind: "accepted-ir" },
    ]);
    expect(baseline.contextBudgetTokens).toBe(40);
  });

  it("rejects a forged frozen baseline measurement", () => {
    const baseline = createNir1PackingBaseline({ budget, items: atomicItems });
    const forgedMeasurement = Object.freeze({
      ...baseline.tokenMeasurement,
      measureItemTokens: () => 0,
    });
    const forged = Object.freeze({
      ...baseline,
      tokenMeasurement: forgedMeasurement,
    });
    expect(() =>
      selectNir1RawPriorityBaseline({
        budget,
        items: atomicItems,
        baseline: forged,
      }),
    ).toThrow(/token measurement/);
  });

  it("keeps required Raw and complete atomic groups together", () => {
    const result = selectNir1PackingItems({
      budget,
      items: qualifiedAtomicItems,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual([
      "raw",
      "statement",
      "negation",
      "attribution",
      "evidence",
      "qualification",
    ]);
    expect(result.rejectedGroups).toEqual([]);
  });

  it("requires Raw in both empty and non-Raw-only requests", () => {
    const nonRaw = qualifiedAtomicItems.filter((item) => item.kind !== "raw");
    for (const items of [[], nonRaw]) {
      expect(() =>
        selectNir1PackingItems({
          budget,
          items,
          qualificationMode: "fixture",
        }),
      ).toThrow(/at least one required Raw context item/);
      expect(() =>
        selectNir1RawPriorityBaseline({
          budget,
          items,
        }),
      ).toThrow(/at least one required Raw context item/);
    }
    expect(() =>
      createNir1ContextPlan({
        budget,
        items: nonRaw,
        qualificationMode: "fixture",
      }),
    ).toThrow(/at least one required Raw context item/);
  });

  it("rejects an incomplete statement group", () => {
    const incomplete = qualifiedAtomicItems.filter(
      (item) => item.id !== "evidence",
    );
    const result = selectNir1PackingItems({
      budget,
      items: incomplete,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual(["raw"]);
    expect(result.rejectedGroups).toEqual(["g"]);
  });

  it("reconstructs by exact member IDs when a Raw ID collides with a group ID", () => {
    const structural: readonly Nir1PackingItem[] = Object.freeze([
      { id: "same", kind: "raw", text: "Raw", tokens: 2 },
      {
        id: "group-statement",
        kind: "accepted-ir",
        atomicGroup: "same",
        atomicPart: "statement",
        text: "Statement",
        tokens: 2,
      },
      {
        id: "group-negation",
        kind: "accepted-ir",
        atomicGroup: "same",
        atomicPart: "negation",
        text: "Negation",
        tokens: 2,
      },
      {
        id: "group-attribution",
        kind: "accepted-ir",
        atomicGroup: "same",
        atomicPart: "attribution",
        text: "Attribution",
        tokens: 2,
      },
      {
        id: "group-evidence",
        kind: "accepted-ir",
        atomicGroup: "same",
        atomicPart: "evidence",
        text: "Evidence",
        tokens: 2,
      },
      {
        id: "group-qualification",
        kind: "accepted-ir",
        atomicGroup: "same",
        atomicPart: "qualification",
        text: "Qualification",
        tokens: 1,
      },
    ]);
    const colliding = structural.map((item) =>
      item.kind === "raw"
        ? item
        : adaptNir1FixtureQualifiedInput({
            source: "fixture-only-a2-adapter",
            item,
            reader: currentReader("collision"),
          }),
    );
    const complete = selectNir1PackingItems({
      budget,
      items: colliding,
      qualificationMode: "fixture",
    });
    expect(complete.selectedIds).toEqual([
      "same",
      "group-statement",
      "group-negation",
      "group-attribution",
      "group-evidence",
      "group-qualification",
    ]);
    expect(new Set(complete.cache.selectedKeys).size).toBe(2);

    const incompleteColliding = colliding.filter(
      (item) => item.id !== "group-qualification",
    );
    const result = selectNir1PackingItems({
      budget,
      items: incompleteColliding,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual(["same"]);
    expect(result.rejectedGroups).toEqual(["same"]);
    expect(result.selectedIds).not.toContain("group-statement");
  });

  it("rejects interleaved atomic groups so every surface has one order", () => {
    const interleaved = [
      qualifiedAtomicItems[0],
      qualifiedAtomicItems[1],
      { id: "raw-middle", kind: "raw" as const, text: "middle", tokens: 1 },
      ...qualifiedAtomicItems.slice(2),
    ];
    const result = selectNir1PackingItems({
      budget,
      items: interleaved,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual(["raw", "raw-middle"]);
    expect(result.rejectedGroups).toEqual(["g"]);
    expect(result.cache.selectedIds).toEqual(result.selectedIds);
  });

  it("requires exactly one part, one kind, and one qualification tuple", () => {
    const duplicate = qualifiedAtomicItems.map((item) =>
      item.id === "evidence"
        ? { ...item, atomicPart: "statement" as const }
        : item,
    );
    expect(
      selectNir1PackingItems({
        budget,
        items: duplicate,
        qualificationMode: "fixture",
      }).selectedIds,
    ).toEqual(["raw"]);
    const mixedKind = qualifiedAtomicItems.map((item) =>
      item.id === "negation"
        ? { ...item, kind: "graph-evidence" as const }
        : item,
    );
    expect(
      selectNir1PackingItems({
        budget,
        items: mixedKind,
        qualificationMode: "fixture",
      }).selectedIds,
    ).toEqual(["raw"]);
    const mixedProof = qualifiedAtomicItems.map((item) =>
      item.id === "negation"
        ? {
            ...item,
            qualificationProof: {
              provenance: "fixture-only" as const,
              reader: currentReader("other"),
            },
          }
        : item,
    );
    expect(
      selectNir1PackingItems({
        budget,
        items: mixedProof,
        qualificationMode: "fixture",
      }).selectedIds,
    ).toEqual(["raw"]);
  });

  it("keeps accepted IR ahead of author declared groups at the shared priority boundary", () => {
    const priorityBudget: Nir1PackingBudget = Object.freeze({
      contextWindowTokens: 22,
      systemTokens: 4,
      historyTokens: 4,
      toolTokens: 4,
      responseReservationTokens: 4,
    });
    const parts = [
      ["statement", "statement"],
      ["negation", "negation"],
      ["attribution", "attribution"],
      ["evidence", "evidence"],
      ["qualification", "qualification"],
    ] as const;
    const priorityItems: Nir1PackingItem[] = [
      { id: "raw:priority", kind: "raw", text: "Raw", tokens: 1 },
      ...parts.map(([atomicPart, text]) =>
        adaptNir1FixtureQualifiedInput({
          source: "fixture-only-a2-adapter",
          item: {
            id: `accepted-${atomicPart}`,
            kind: "accepted-ir",
            atomicGroup: "priority-accepted",
            atomicPart,
            text,
            tokens: 1,
          },
          reader: currentReader("priority"),
        }),
      ),
      ...parts.map(([atomicPart, text]) => ({
        id: `author-${atomicPart}`,
        kind: "author-declared" as const,
        atomicGroup: "priority-author",
        atomicPart,
        text,
        tokens: 1,
      })),
    ];
    const result = selectNir1PackingItems({
      budget: priorityBudget,
      items: priorityItems,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual([
      "raw:priority",
      "accepted-statement",
      "accepted-negation",
      "accepted-attribution",
      "accepted-evidence",
      "accepted-qualification",
    ]);
    expect(result.selectedText).toEqual([
      "Raw",
      "statement",
      "negation",
      "attribution",
      "evidence",
      "qualification",
    ]);
  });

  it("uses the shared graph-over-accepted packing order and skips oversized high groups", () => {
    const parts = [
      ["statement", 5],
      ["negation", 10],
      ["attribution", 2],
      ["evidence", 18],
      ["qualification", 1],
    ] as const;
    const graph = parts.map(([atomicPart, tokens]) =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: `graph-${atomicPart}`,
          kind: "graph-evidence",
          atomicGroup: "p12-graph",
          atomicPart,
          text: atomicPart,
          tokens,
        },
        reader: currentReader("p12-graph"),
      }),
    );
    const accepted = [
      "statement",
      "negation",
      "attribution",
      "evidence",
      "qualification",
    ].map((atomicPart) =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: `accepted-${atomicPart}`,
          kind: "accepted-ir",
          atomicGroup: "p12-accepted",
          atomicPart: atomicPart as Nir1PackingItem["atomicPart"],
          text: atomicPart,
          tokens: 2,
        },
        reader: currentReader("p12-accepted"),
      }),
    );
    const p12 = selectNir1PackingItems({
      budget: {
        contextWindowTokens: 64,
        systemTokens: 8,
        historyTokens: 4,
        toolTokens: 4,
        responseReservationTokens: 8,
      },
      items: [
        { id: "p12-raw", kind: "raw", text: "Raw", tokens: 4 },
        ...graph,
        ...accepted,
      ],
      qualificationMode: "fixture",
    });
    expect(p12.usedTokens).toBe(40);
    expect(p12.selectedIds).toEqual([
      "p12-raw",
      "graph-statement",
      "graph-negation",
      "graph-attribution",
      "graph-evidence",
      "graph-qualification",
    ]);

    const makeAccepted = (group: string, prefix: string, tokens: number) =>
      ["statement", "negation", "attribution", "evidence", "qualification"].map(
        (atomicPart) =>
          adaptNir1FixtureQualifiedInput({
            source: "fixture-only-a2-adapter",
            item: {
              id: `${prefix}-${atomicPart}`,
              kind: "accepted-ir",
              atomicGroup: group,
              atomicPart: atomicPart as Nir1PackingItem["atomicPart"],
              text: atomicPart,
              tokens,
            },
            reader: currentReader(group),
          }),
      );
    const tie = selectNir1PackingItems({
      budget: {
        ...budget,
        contextWindowTokens: 26,
        responseReservationTokens: 4,
      },
      items: [
        { id: "raw:shared", kind: "raw", text: "Raw", tokens: 1 },
        ...makeAccepted("tie-first", "first", 1),
        ...makeAccepted("tie-second", "second", 1),
      ],
      qualificationMode: "fixture",
    });
    expect(tie.selectedIds).toEqual([
      "raw:shared",
      "first-statement",
      "first-negation",
      "first-attribution",
      "first-evidence",
      "first-qualification",
    ]);

    const oversizedGraph = [
      "statement",
      "negation",
      "attribution",
      "evidence",
      "qualification",
    ].map((atomicPart) =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: `high-${atomicPart}`,
          kind: "graph-evidence",
          atomicGroup: "oversized-high",
          atomicPart: atomicPart as Nir1PackingItem["atomicPart"],
          text: atomicPart,
          tokens: 9,
        },
        reader: currentReader("oversized-high"),
      }),
    );
    const fallback = selectNir1PackingItems({
      budget: {
        ...budget,
        contextWindowTokens: 26,
        responseReservationTokens: 4,
      },
      items: [
        { id: "raw:shared", kind: "raw", text: "Raw", tokens: 1 },
        ...oversizedGraph,
        ...makeAccepted("small-fallback", "small", 1),
      ],
      qualificationMode: "fixture",
    });
    expect(fallback.selectedIds).toEqual([
      "raw:shared",
      "small-statement",
      "small-negation",
      "small-attribution",
      "small-evidence",
      "small-qualification",
    ]);
  });

  it("gates complete unreviewed groups by purpose before selection", () => {
    const unreviewed = atomicItems.map((item) =>
      item.kind === "raw"
        ? item
        : {
            ...item,
            kind: "unreviewed-for-review" as const,
          },
    );
    const writing = selectNir1PackingItems({
      budget,
      items: unreviewed,
      purpose: "writing",
      qualificationMode: "fixture",
    });
    expect(writing.selectedIds).toEqual(["raw"]);
    expect(writing.rejectedGroups).toEqual(["g"]);
    const review = selectNir1PackingItems({
      budget,
      items: unreviewed,
      purpose: "review",
      qualificationMode: "fixture",
    });
    expect(review.selectedIds).toHaveLength(6);
  });

  it("plans semantic selection once and lets cache planning retain the selection", () => {
    const plan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      qualificationMode: "fixture",
    });
    expect(plan.selectionCount).toBe(1);
    expect(plan.cache.selectedIds).toEqual(plan.selectedIds);
    expect(plan.cache.droppedIds).toEqual([]);
  });

  it("re-evaluates when any cache binding component is stale", () => {
    const binding = {
      scopeToken: "scope",
      sourceToken: "source",
      revisionId: "revision",
      decisionId: "decision",
      freshnessToken: "fresh",
      indexGeneration: "index",
    } as const;
    expect(isNir1CacheBindingCurrent(binding, binding)).toBe(true);
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      expect(
        isNir1CacheBindingCurrent(binding, {
          ...binding,
          [key]: `${binding[key]}-stale`,
        }),
      ).toBe(false);
    }
  });

  it("does not reuse a cache when its own binding or material/request changes", () => {
    const binding = {
      scopeToken: "scope",
      sourceToken: "source",
      revisionId: "revision",
      decisionId: "decision",
      freshnessToken: "fresh",
      indexGeneration: "index",
    } as const;
    const plan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "request-a",
      binding,
      qualificationMode: "fixture",
    });
    const same = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "request-a",
      binding,
      cachedPlan: plan,
      cachedBinding: binding,
      qualificationMode: "fixture",
    });
    expect(same).toBe(plan);
    const staleCallerHint = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "request-a",
      binding,
      cachedPlan: plan,
      cachedBinding: { ...binding, revisionId: "caller-hint-is-ignored" },
      qualificationMode: "fixture",
    });
    expect(staleCallerHint).toBe(plan);
    const changed = replanNir1Context({
      budget,
      items: qualifiedAtomicItems.map((item) =>
        item.id === "statement" ? { ...item, text: "changed" } : item,
      ),
      requestId: "request-a",
      binding,
      cachedPlan: plan,
      cachedBinding: binding,
      qualificationMode: "fixture",
    });
    expect(changed).not.toBe(plan);
    const reordered = replanNir1Context({
      budget,
      items: [...qualifiedAtomicItems].reverse(),
      requestId: "request-a",
      binding,
      cachedPlan: plan,
      qualificationMode: "fixture",
    });
    expect(reordered).not.toBe(plan);
    const budgetChanged = replanNir1Context({
      budget: { ...budget, toolTokens: budget.toolTokens + 1 },
      items: qualifiedAtomicItems,
      requestId: "request-a",
      binding,
      cachedPlan: plan,
      qualificationMode: "fixture",
    });
    expect(budgetChanged).not.toBe(plan);
    const requestChanged = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "request-b",
      binding,
      cachedPlan: plan,
      qualificationMode: "fixture",
    });
    expect(requestChanged).not.toBe(plan);
    const spoofed = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "request-a",
      binding,
      cachedPlan: { ...plan, binding: { ...binding, revisionId: "spoofed" } },
      cachedBinding: binding,
      qualificationMode: "fixture",
    });
    expect(spoofed).not.toBe(plan);

    const unboundPlan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "unbound-request",
      qualificationMode: "fixture",
    });
    expect(
      replanNir1Context({
        budget,
        items: qualifiedAtomicItems,
        requestId: "unbound-request",
        cachedPlan: unboundPlan,
        qualificationMode: "fixture",
      }),
    ).not.toBe(unboundPlan);
  });

  it("replans each P-10 binding-only mutation while retaining the same material", () => {
    const binding = {
      scopeToken: "scope",
      sourceToken: "source",
      revisionId: "revision",
      decisionId: "decision",
      freshnessToken: "fresh",
      indexGeneration: "index",
    } as const;
    const cachedPlan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "P-10-binding-only",
      binding,
      qualificationMode: "fixture",
    });
    for (const key of Object.keys(binding) as Array<keyof typeof binding>) {
      const currentBinding = { ...binding, [key]: `${binding[key]}-changed` };
      const replanned = replanNir1Context({
        budget,
        items: qualifiedAtomicItems,
        requestId: "P-10-binding-only",
        binding: currentBinding,
        cachedPlan,
        qualificationMode: "fixture",
      });
      expect(replanned).not.toBe(cachedPlan);
      expect(replanned.selectedIds).toEqual(cachedPlan.selectedIds);
      expect(replanned.selectedItems.map((item) => item.text)).toEqual(
        cachedPlan.selectedItems.map((item) => item.text),
      );
      expect(replanned.plan.usage.selectedTokens).toBe(
        cachedPlan.plan.usage.selectedTokens,
      );
    }
  });

  it("keeps ContextPlan trim accounting and rejects copied or inconsistent plans", () => {
    const cachedPlan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "plan-integrity",
      binding: {
        scopeToken: "scope",
        sourceToken: "source",
        revisionId: "revision",
        decisionId: "decision",
        freshnessToken: "fresh",
        indexGeneration: "index",
      },
      qualificationMode: "fixture",
    });
    expect(cachedPlan.plan.usage.trimmedTokens).toBe(
      cachedPlan.plan.usage.candidateTokens -
        cachedPlan.plan.usage.selectedTokens,
    );
    const firstContextItem = cachedPlan.plan.items[0];
    expect(firstContextItem).toBeDefined();
    expect(Object.isFrozen(firstContextItem?.trim)).toBe(true);
    expect(Object.isFrozen(firstContextItem?.provenance)).toBe(true);
    const copied = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "plan-integrity",
      binding: cachedPlan.binding,
      cachedPlan: { ...cachedPlan },
      qualificationMode: "fixture",
    });
    expect(copied).not.toBe(cachedPlan);
    const tampered = {
      ...cachedPlan,
      selectedIds: Object.freeze(["foreign"]),
    } as typeof cachedPlan;
    const replanned = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "plan-integrity",
      binding: cachedPlan.binding,
      cachedPlan: tampered,
      qualificationMode: "fixture",
    });
    expect(replanned).not.toBe(tampered);
    expect(replanned.selectedIds).toEqual(cachedPlan.selectedIds);
    const nestedTampered = {
      ...cachedPlan,
      plan: {
        ...cachedPlan.plan,
        usage: {
          ...cachedPlan.plan.usage,
          trimmedTokens: cachedPlan.plan.usage.trimmedTokens + 1,
        },
      },
    } as typeof cachedPlan;
    const nestedReplanned = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "plan-integrity",
      binding: cachedPlan.binding,
      cachedPlan: nestedTampered,
      qualificationMode: "fixture",
    });
    expect(nestedReplanned).not.toBe(nestedTampered);
    expect(nestedReplanned.plan.usage.trimmedTokens).toBe(
      cachedPlan.plan.usage.trimmedTokens,
    );
  });

  it("replans when qualification mode or proof authenticity changes", () => {
    const fixturePlan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "qualification-mode",
      qualificationMode: "fixture",
    });
    const nativeMode = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "qualification-mode",
      cachedPlan: fixturePlan,
      qualificationMode: "native",
    });
    expect(nativeMode).not.toBe(fixturePlan);
    expect(nativeMode.selectedIds).toEqual(["raw"]);

    const nativeModePlan = createNir1ContextPlan({
      budget,
      items: qualifiedAtomicItems,
      requestId: "qualification-mode",
      qualificationMode: "native",
    });
    const fixtureMode = replanNir1Context({
      budget,
      items: qualifiedAtomicItems,
      requestId: "qualification-mode",
      cachedPlan: nativeModePlan,
      qualificationMode: "fixture",
    });
    expect(fixtureMode).not.toBe(nativeModePlan);
    expect(fixtureMode.selectedIds).toEqual(
      qualifiedAtomicItems.map((item) => item.id),
    );

    const clonedInput = structuredClone(
      qualifiedAtomicItems,
    ) as Nir1PackingItem[];
    const clonedPlan = replanNir1Context({
      budget,
      items: clonedInput,
      requestId: "qualification-mode",
      cachedPlan: fixturePlan,
      qualificationMode: "fixture",
    });
    expect(clonedPlan).not.toBe(fixturePlan);
    expect(clonedPlan.selectedIds).toEqual(["raw"]);
  });

  it("measures baseline and candidate arms from the same frozen material", () => {
    const baselineItems = qualifiedAtomicItems;
    const baseline = createNir1PackingBaseline({
      budget,
      items: baselineItems,
    });
    const baselineArm = selectNir1RawPriorityBaseline({
      budget,
      items: baselineItems,
      baseline,
    });
    const candidateArm = selectNir1PackingItems({
      budget,
      items: qualifiedAtomicItems,
      baseline,
      qualificationMode: "fixture",
    });
    expect(baselineArm.arm).toBe("raw-priority-baseline");
    expect(candidateArm.arm).toBe("candidate");
    expect(baselineArm.usedTokens).toBe(candidateArm.usedTokens);
    expect(baselineArm.selectedIds).toEqual(candidateArm.selectedIds);
    expect(baselineArm.qualifiedGroupIds).toEqual([]);
    expect(candidateArm.qualifiedGroupIds).toEqual(["g"]);
  });

  it("keeps synthetic qualification explicitly fixture-only", () => {
    const item = adaptNir1FixtureQualifiedInput({
      source: "fixture-only-a2-adapter",
      item: {
        id: "native-ir",
        kind: "accepted-ir",
        atomicGroup: "native-group",
        atomicPart: "statement",
        text: "Native statement",
        tokens: 2,
      },
      reader: currentReader(),
    });
    expect(item.qualificationProof?.reader.source).toBe(
      "fixture-only-a2-current-reader",
    );
    expect(Object.isFrozen(item)).toBe(true);
    expect(
      selectNir1PackingItems({
        budget,
        items: qualifiedAtomicItems,
      }).selectedIds,
    ).toEqual(["raw"]);
    expect(() =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: "raw",
          kind: "raw",
          text: "Raw",
          tokens: 1,
        },
        reader: currentReader(),
      }),
    ).toThrow(/only accepted-ir and graph-evidence/);
    expect(() =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: "stale",
          kind: "accepted-ir",
          atomicGroup: "stale-group",
          atomicPart: "statement",
          text: "Stale",
          tokens: 1,
        },
        reader: {
          ...currentReader(),
          status: "stale",
        } as unknown as Nir1FixtureA2CurrentReaderOutput,
      }),
    ).toThrow(/must be current/);
    expect(() =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: "rejected",
          kind: "graph-evidence",
          atomicGroup: "rejected-group",
          atomicPart: "statement",
          text: "Rejected",
          tokens: 1,
        },
        reader: {
          ...currentReader(),
          decision: "rejected",
        } as unknown as Nir1FixtureA2CurrentReaderOutput,
      }),
    ).toThrow(/must be approved/);
    expect(() =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: "no-evidence",
          kind: "accepted-ir",
          atomicGroup: "no-evidence-group",
          atomicPart: "statement",
          text: "No evidence",
          tokens: 1,
        },
        reader: { ...currentReader(), evidenceRef: "" },
      }),
    ).toThrow(/evidenceRef/);
    const { decisionId: _decisionId, ...missingDecision } = currentReader();
    expect(() =>
      adaptNir1FixtureQualifiedInput({
        source: "fixture-only-a2-adapter",
        item: {
          id: "missing-field",
          kind: "accepted-ir",
          atomicGroup: "missing-field-group",
          atomicPart: "statement",
          text: "Missing field",
          tokens: 1,
        },
        reader: missingDecision as Nir1FixtureA2CurrentReaderOutput,
      }),
    ).toThrow(/decisionId/);
  });

  it("rejects a structurally forged qualification proof", () => {
    const forged = atomicItems.map((item) =>
      item.kind === "raw"
        ? item
        : {
            ...item,
            qualificationProof: {
              provenance: "fixture-only" as const,
              reader: currentReader(),
            },
          },
    );
    const result = selectNir1PackingItems({
      budget,
      items: forged,
      qualificationMode: "fixture",
    });
    expect(result.selectedIds).toEqual(["raw"]);
    expect(result.rejectedGroups).toEqual(["g"]);
  });
});
