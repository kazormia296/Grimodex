import { describe, expect, it } from "vitest";

import contractStringFixture from "../../../../policies/narrative/fixtures/contract-string-parity.json";
import {
  CONTRACT_WHITESPACE_CODE_POINTS,
  isContractNonEmptyString,
  isContractTrimmedNonEmptyString,
  isContractWhitespaceCodePoint,
} from "./contractString";
import {
  DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
  validateDependencyEffectRegistry,
  validateDependencySelector,
} from "./dependencyRole";
import { validateNarrativeRevisionEnvelopeV2 } from "./narrativeIr";
import { validateNarrativeScopeV2 } from "./scopeV2";

interface WhitespaceFixtureValue {
  readonly id: string;
  readonly codePoint: string;
  readonly value: string;
}

interface ParityOperation {
  readonly id: string;
  readonly kind: string;
  readonly edgeWhitespaceExpected: boolean;
  readonly unicodeContentExpected: boolean;
}

interface ContractStringParityFixture {
  readonly whitespaceValues: readonly WhitespaceFixtureValue[];
  readonly unicodeContents: readonly {
    readonly id: string;
    readonly value: string;
  }[];
  readonly asciiNormalizerVersion: string;
  readonly operations: readonly ParityOperation[];
}

const fixture = contractStringFixture as ContractStringParityFixture;
const DIGEST = `sha256:${"a".repeat(64)}`;
type MutableRecord = Record<string, unknown>;

function validScope(): MutableRecord {
  return {
    schemaVersion: 2,
    registryVersion: "narrative-scope/2",
    timeline: { kind: "any" },
    worldline: { kind: "any" },
    scene: { kind: "exact", ref: "scene:1" },
    viewpoint: { kind: "any" },
    knowledgeHolder: { kind: "any" },
    audience: { kind: "any" },
    narrativeLayer: { kind: "any" },
    storyTime: { kind: "any" },
    readingOrder: { kind: "any" },
  };
}

function validEnvelope(): MutableRecord {
  return {
    schemaVersion: 2,
    assertion: {
      assertionId: null,
      assertionKind: "scene-event@1",
      payloadSchemaRef: { id: "narrative.scene-event", version: "1" },
      payload: { eventId: "event:1" },
      scope: validScope(),
      modality: "modality-explicit-text",
      polarity: "affirmative",
      supportClass: "direct-source",
      producer: { kind: "reconciler-proposal", id: "chronicle", version: "1" },
    },
    assertionDigests: {
      assertionCoreDigest: DIGEST,
      scopeDigest: DIGEST,
      assertionDigest: DIGEST,
    },
    changeIntent: { changeKind: "add" },
    effectiveMaterialBasis: {
      sourceBasis: [
        { sourceKind: "scene", sourceKey: "scene:1", revisionToken: "rev:1" },
      ],
      evidenceSet: [{ evidenceRef: "anchor:1" }],
      dependencySet: [
        {
          dependencyId: "dependency:1",
          inputRef: "anchor:1",
          contextIds: [],
          role: "direct-evidence",
          selector: { kind: "whole-source" },
        },
      ],
      dependencySetDigest: DIGEST,
      materialBasisDigest: DIGEST,
    },
    revisionBasis: {
      kind: "interpretation",
      runId: "run:1",
      taskId: "task:1",
      producer: { kind: "reconciler-proposal", id: "chronicle", version: "1" },
      contextSet: [],
      contextSetDigest: DIGEST,
      componentContractDigest: DIGEST,
      finalRequestDigest: DIGEST,
    },
    projectionBinding: {
      proposalKind: "chronicle.create-event@1",
      proposalSchemaRef: {
        id: "narrative.chronicle-event.create",
        version: "1",
      },
      proposalPayloadDigest: DIGEST,
      adapterContractId: "chronicle.scene-event",
      adapterContractVersion: "1",
    },
  };
}

function isValidOperation(kind: string, value: string): boolean {
  switch (kind) {
    case "scope-exact-ref": {
      const scope = validScope();
      (scope.scene as MutableRecord).ref = value;
      return validateNarrativeScopeV2(scope).valid;
    }
    case "scope-unresolved-constraint-id": {
      const scope = validScope();
      (scope.audience as MutableRecord).kind = "unresolved";
      (scope.audience as MutableRecord).reason = "ambiguous";
      (scope.audience as MutableRecord).constraintId = value;
      return validateNarrativeScopeV2(scope).valid;
    }
    case "scope-interval-boundary": {
      const scope = validScope();
      (scope.storyTime as MutableRecord).kind = "interval";
      (scope.storyTime as MutableRecord).from = {
        ref: value,
        inclusive: true,
      };
      return validateNarrativeScopeV2(scope).valid;
    }
    case "narrative-ir-assertion-id": {
      const envelope = validEnvelope();
      (envelope.assertion as MutableRecord).assertionId = value;
      return validateNarrativeRevisionEnvelopeV2(envelope).valid;
    }
    case "narrative-ir-context-id": {
      const envelope = validEnvelope();
      (envelope.revisionBasis as MutableRecord).contextSet = [
        {
          contextId: value,
          inputRef: "source:context",
          stageId: "stage:1",
          exposure: "deterministic-stage",
          selector: { kind: "whole-source" },
        },
      ];
      return validateNarrativeRevisionEnvelopeV2(envelope).valid;
    }
    case "narrative-ir-component-contract-id": {
      const envelope = validEnvelope();
      (envelope.projectionBinding as MutableRecord).adapterContractId = value;
      return validateNarrativeRevisionEnvelopeV2(envelope).valid;
    }
    case "d0-field-path-object-identity":
      return validateDependencySelector({
        kind: "field-path",
        objectIdentity: value,
        fieldPath: "title",
      }).valid;
    case "d0-field-path":
      return validateDependencySelector({
        kind: "field-path",
        objectIdentity: "object:1",
        fieldPath: value,
      }).valid;
    case "d0-exact-object-set":
      return validateDependencySelector({
        kind: "exact-object-set",
        objectIdentities: [value],
        setDigest: DIGEST,
      }).valid;
    case "d0-component-contract-id":
      return validateDependencySelector({
        kind: "component-contract",
        contractId: value,
        contractDigest: DIGEST,
      }).valid;
    case "d0-normalizer-version":
      return validateDependencySelector({
        kind: "text-range",
        unit: "utf16",
        from: 0,
        to: 1,
        normalizerVersion: value,
      }).valid;
    case "dependency-effect-rule-id": {
      const registry = structuredClone(DEFAULT_DEPENDENCY_EFFECT_REGISTRY);
      registry.effectRules[0] = { ...registry.effectRules[0], id: value };
      return validateDependencyEffectRegistry(registry).length === 0;
    }
    default:
      throw new Error(`unknown parity operation: ${kind}`);
  }
}

describe("narrative contract string TS/Rust parity fixture", () => {
  it("keeps the explicit whitespace code-point set and boundary predicates stable", () => {
    expect([...CONTRACT_WHITESPACE_CODE_POINTS]).toEqual(
      fixture.whitespaceValues.map((entry) =>
        Number.parseInt(entry.codePoint.slice(2), 16),
      ),
    );

    for (const entry of fixture.whitespaceValues) {
      const codePoint = Number.parseInt(entry.codePoint.slice(2), 16);
      expect(isContractWhitespaceCodePoint(codePoint), entry.id).toBe(true);
      expect(isContractNonEmptyString(entry.value), entry.id).toBe(false);
      expect(isContractTrimmedNonEmptyString(entry.value), entry.id).toBe(
        false,
      );
    }
  });

  it("uses one acceptance decision for Scope, Narrative IR, D0, and normalizer cases", () => {
    for (const operation of fixture.operations) {
      for (const whitespace of fixture.whitespaceValues) {
        expect(
          isValidOperation(operation.kind, whitespace.value),
          `${operation.id}/${whitespace.id}/only`,
        ).toBe(false);
        expect(
          isValidOperation(operation.kind, `${whitespace.value}x`),
          `${operation.id}/${whitespace.id}/leading`,
        ).toBe(operation.edgeWhitespaceExpected);
        expect(
          isValidOperation(operation.kind, `x${whitespace.value}`),
          `${operation.id}/${whitespace.id}/trailing`,
        ).toBe(operation.edgeWhitespaceExpected);
      }

      for (const content of fixture.unicodeContents) {
        expect(
          isValidOperation(operation.kind, content.value),
          `${operation.id}/${content.id}`,
        ).toBe(operation.unicodeContentExpected);
      }
    }

    const normalizer = fixture.operations.find(
      (operation) => operation.kind === "d0-normalizer-version",
    );
    expect(normalizer).toBeDefined();
    expect(
      isValidOperation(normalizer!.kind, fixture.asciiNormalizerVersion),
    ).toBe(true);
  });
});
