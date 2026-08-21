import { describe, expect, it } from "vitest";

import dependencyFixture from "../../../../policies/narrative/fixtures/dependency-role-contract.json";
import {
  DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
  aggregateDependencyBuildActions,
  canonicalizeDependencySelector,
  canonicalizeDependencySet,
  computeDependencyKey,
  computeDependencySetDigestSync,
  evaluateDependencyEffect,
  validateDependencyEffectRegistry,
  validateDependencySelector,
} from "./dependencyRole";

type FixtureCase = (typeof dependencyFixture.cases)[number];

describe("narrative dependency role contract", () => {
  it("evaluates representative Role × Consumer × Source Change effects", () => {
    const cases = dependencyFixture.cases.filter(
      (fixtureCase): fixtureCase is FixtureCase & {
        input: { role: string; consumerKind: string; changeClass: string };
        expected: {
          freshness: string;
          reasonCode: string | null;
          buildAction: string;
          actionRequirement: string;
        };
      } => fixtureCase.kind === "effect-evaluation" && fixtureCase.expected !== "reject",
    );

    for (const fixtureCase of cases) {
      const result = evaluateDependencyEffect(
        DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
        fixtureCase.input,
      );
      expect(result, fixtureCase.id).toEqual({
        ok: true,
        effect: fixtureCase.expected,
      });
    }
  });

  it("fails closed for unknown roles, selectors, and undefined combinations", () => {
    const unknownRole = dependencyFixture.cases.find(
      (fixtureCase) => fixtureCase.id === "unknown-role-fails-closed",
    );
    const unknownCombination = dependencyFixture.cases.find(
      (fixtureCase) => fixtureCase.id === "unknown-effect-combination-fails-closed",
    );
    const unknownSelector = dependencyFixture.cases.find(
      (fixtureCase) => fixtureCase.id === "unknown-selector-fails-closed",
    );

    expect(
      evaluateDependencyEffect(DEFAULT_DEPENDENCY_EFFECT_REGISTRY, unknownRole!.input),
    ).toMatchObject({ ok: false, error: { code: "unknown-role" } });
    expect(
      evaluateDependencyEffect(
        DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
        unknownCombination!.input,
      ),
    ).toMatchObject({ ok: false, error: { code: "missing-effect-rule" } });
    expect(validateDependencySelector(unknownSelector!.selector)).toEqual({
      valid: false,
      error: { code: "unknown-selector" },
    });
  });

  it("canonicalizes selectors and computes a stable Role + Selector key", async () => {
    const fixtureCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "whole-source-dependency-key-golden",
    )!;

    expect(canonicalizeDependencySelector(fixtureCase.selector)).toBe(
      fixtureCase.canonicalSelector,
    );
    await expect(
      computeDependencyKey(fixtureCase.role, fixtureCase.selector),
    ).resolves.toBe(fixtureCase.dependencyKey);
  });

  it("keeps UTF-16 object identity and dependency-set tuple parity", async () => {
    const selectorCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "utf16-object-identity-order-golden",
    )!;
    expect(canonicalizeDependencySelector(selectorCase.selector)).toBe(
      selectorCase.canonicalSelector,
    );
    await expect(
      computeDependencyKey(selectorCase.role, selectorCase.selector),
    ).resolves.toBe(selectorCase.dependencyKey);

    const setCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "utf16-dependency-set-tuple-order-golden",
    )!;
    expect(canonicalizeDependencySet(setCase.entries)).toBe(
      setCase.canonicalDependencySet,
    );
    expect(computeDependencySetDigestSync(setCase.entries)).toBe(
      setCase.dependencySetDigest,
    );
  });

  it("rejects a UTF-16 range beyond JavaScript's safe integer boundary", () => {
    const fixtureCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "utf16-range-rejects-unsafe-integer",
    )!;
    expect(validateDependencySelector(fixtureCase.selector)).toEqual({
      valid: false,
      error: { code: "invalid-range" },
    });
  });

  it("fails closed when the registry omits a consumer kind", () => {
    const incomplete = {
      ...DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
      consumerKinds: DEFAULT_DEPENDENCY_EFFECT_REGISTRY.consumerKinds.slice(1),
    };
    expect(validateDependencyEffectRegistry(incomplete)).toContain(
      "registry consumer kinds are incomplete or contain unknown or duplicate values",
    );
  });

  it("rejects a text range that begins inside a UTF-16 surrogate pair", () => {
    const fixtureCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "utf16-range-rejects-surrogate-interior",
    )!;
    expect(validateDependencySelector(fixtureCase.selector, fixtureCase.source)).toEqual({
      valid: false,
      error: { code: "surrogate-boundary" },
    });
  });

  it("keeps required Build Actions independent from advisory Freshness", () => {
    const fixtureCase = dependencyFixture.cases.find(
      (candidate) => candidate.id === "mixed-actions-stay-independent",
    )!;
    expect(aggregateDependencyBuildActions(fixtureCase.effects)).toEqual(
      fixtureCase.expected,
    );
  });
});
