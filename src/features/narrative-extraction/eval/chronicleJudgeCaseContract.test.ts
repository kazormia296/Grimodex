import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import actualFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-actual-001.json";
import dreamFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-dream-001.json";
import hearsayFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-hearsay-001.json";
import manifest from "../../../../evals/narrative/contracts/chronicle-transfer-v1/manifest.json";
import planFixture from "../../../../evals/narrative/contracts/chronicle-transfer-v1/transfer-plan-001.json";
import schema from "../../../../evals/narrative/contracts/chronicle-transfer-v1/contract.schema.json";
import { sha256Digest } from "../source/digest";
import {
  CHRONICLE_JUDGE_CASE_CONTRACT_VERSION,
  CHRONICLE_JUDGE_CASE_SCHEMA_VERSION,
  loadChronicleJudgeCaseContract,
  loadChronicleJudgeCaseManifest,
  verifyChronicleJudgeCaseSourceDigest,
} from "./chronicleJudgeCaseContract";

const fixtures = [
  actualFixture,
  planFixture,
  hearsayFixture,
  dreamFixture,
] as const;

function cloneFixture(index: number): Record<string, unknown> {
  return structuredClone(fixtures[index]) as Record<string, unknown>;
}

function expectLoaded(candidate: unknown) {
  const result = loadChronicleJudgeCaseContract(candidate);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("fixture did not load");
  return result.value;
}

describe("Chronicle transfer judge case contract", () => {
  it("keeps the transfer schema, manifest, and four fixtures aligned", () => {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validateSchema = ajv.compile(schema);

    for (const fixture of fixtures) {
      expect(validateSchema(fixture)).toBe(true);
      expect(loadChronicleJudgeCaseContract(fixture).ok).toBe(true);
    }

    const manifestResult = loadChronicleJudgeCaseManifest(manifest);
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;
    expect(manifestResult.value).toMatchObject({
      schemaVersion: CHRONICLE_JUDGE_CASE_SCHEMA_VERSION,
      contractVersion: CHRONICLE_JUDGE_CASE_CONTRACT_VERSION,
      suiteId: "chronicle-transfer-v1",
    });
    expect(manifestResult.value.fixtures.map((entry) => entry.caseId)).toEqual([
      "transfer-actual-001",
      "transfer-plan-001",
      "transfer-hearsay-001",
      "transfer-dream-001",
    ]);
  });

  it("retains source-bound Gold meaning and case-specific coverage", async () => {
    const actual = expectLoaded(actualFixture);
    const plan = expectLoaded(planFixture);
    const hearsay = expectLoaded(hearsayFixture);
    const dream = expectLoaded(dreamFixture);

    expect(actual.caseId).toBe("transfer-actual-001");
    expect(actual.coverage).toEqual({
      observation: "exhaustive",
      temporal: "targeted",
      proposal: "targeted",
    });
    expect(actual.observationGold.claims).toHaveLength(2);
    expect(actual.observationGold.claims[0]).toMatchObject({
      id: "A1",
      predicate: "put",
      actuality: "actual",
      attribution: "narrator",
      narrativeFrame: "story-world",
    });
    expect(actual.observationGold.claims[0]?.participants).toEqual([
      { entity: "ナギ", role: "agent" },
      { entity: "赤い布", role: "theme" },
      { entity: "箱", role: "destination" },
    ]);
    const actualSource = actual.sourceDocuments[0];
    if (!actualSource) throw new Error("actual source is missing");
    const colorExclusion = actual.scopeExclusions.find(
      (exclusion) => exclusion.id === "color-descriptor",
    );
    const colorRegion = colorExclusion?.requiredDirectRegions[0];
    expect(colorRegion).toMatchObject({ start: 3, end: 5 });
    expect(actualSource.text.slice(colorRegion?.start, colorRegion?.end)).toBe(
      "赤い",
    );

    expect(plan.coverage.observation).toBe("targeted");
    expect(plan.observationGold.claims[0]).toMatchObject({
      id: "P1",
      actuality: "planned",
      attribution: "character:リナ",
      narrativeFrame: "reported",
    });
    expect(hearsay.observationGold.claims[0]).toMatchObject({
      id: "H1",
      actuality: "rumored",
      attribution: "character:ハル",
      narrativeFrame: "reported",
    });
    expect(hearsay.authorship).toMatchObject({
      semanticGoldStatus: "user-approved",
      runtimeCapability: "supported",
      ordinaryQualityRun: "enabled",
    });
    expect(
      dream.observationGold.claims.map((claim) => claim.actuality),
    ).toEqual(["dreamed", "actual"]);
    expect(
      dream.observationGold.claims.map((claim) => claim.narrativeFrame),
    ).toEqual(["dream", "story-world"]);

    for (const fixture of fixtures) {
      const loaded = expectLoaded(fixture);
      const source = loaded.sourceDocuments[0];
      if (!source) throw new Error("fixture source is missing");
      await expect(sha256Digest(source.text)).resolves.toBe(
        `sha256:${source.textSha256}`,
      );
      await expect(
        verifyChronicleJudgeCaseSourceDigest(loaded),
      ).resolves.toEqual({ ok: true });
      expect(loaded.temporalGold).toEqual({
        coverage: "targeted",
        relations: [],
        unscoredClaimIds: loaded.observationGold.claims.map(
          (claim) => claim.id,
        ),
      });
      expect(loaded.proposalPolicy).toEqual({
        mode: "unscored",
        scoredClaimIds: [],
        reason: "importance-not-annotated",
      });
      expect(loaded.scopeExclusions.length).toBeGreaterThan(0);
      for (const exclusion of loaded.scopeExclusions) {
        expect(exclusion.meaning.trim()).not.toBe("");
        expect(Array.isArray(exclusion.requiredDirectRegions)).toBe(true);
        expect(Array.isArray(exclusion.allowedContextRegions)).toBe(true);
      }
    }
  });

  it("rejects Gold leakage, unknown fields, malformed hashes, and bad regions", () => {
    const unknownField = cloneFixture(0);
    unknownField.gold = "must-not-be-present";
    expect(loadChronicleJudgeCaseContract(unknownField)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CASE_UNKNOWN_FIELD" }),
      ]),
    });

    const staleSourceHash = cloneFixture(0);
    const source = staleSourceHash.sourceDocuments as Array<
      Record<string, unknown>
    >;
    source[0]!.text = "ナギは赤い布を箱に入れた。トウマは箱の蓋を閉めた！";
    expect(loadChronicleJudgeCaseContract(staleSourceHash).ok).toBe(true);
    const staleLoaded = expectLoaded(staleSourceHash);
    return expect(
      verifyChronicleJudgeCaseSourceDigest(staleLoaded),
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "CASE_SOURCE_DIGEST_MISMATCH" }),
      ]),
    });
  });

  it.each([
    [
      "unsupported version",
      (candidate: Record<string, unknown>) => {
        candidate.contractVersion = "chronicle-judge-case-contract/99";
      },
      "CASE_CONTRACT_VERSION_UNSUPPORTED",
    ],
    [
      "empty meaning",
      (candidate: Record<string, unknown>) => {
        const exclusions = candidate.scopeExclusions as Array<
          Record<string, unknown>
        >;
        exclusions[0]!.meaning = "";
      },
      "CASE_SCOPE_EXCLUSION_MEANING_INVALID",
    ],
    [
      "out of bounds direct region",
      (candidate: Record<string, unknown>) => {
        const claims = (candidate.observationGold as Record<string, unknown>)
          .claims as Array<Record<string, unknown>>;
        const regions = claims[0]!.requiredDirectRegions as Array<
          Record<string, unknown>
        >;
        regions[0]!.end = 999;
      },
      "CASE_REGION_OUT_OF_BOUNDS",
    ],
    [
      "H quality run enabled across a representation gap",
      (candidate: Record<string, unknown>) => {
        (candidate.authorship as Record<string, unknown>).runtimeCapability =
          "representation-gap";
        (candidate.authorship as Record<string, unknown>).ordinaryQualityRun =
          "enabled";
      },
      "CASE_RUNTIME_POLICY_INVALID",
    ],
  ] as const)("rejects %s", (_label, mutate, expectedCode) => {
    const candidate = cloneFixture(_label.startsWith("H") ? 2 : 0);
    mutate(candidate);
    const result = loadChronicleJudgeCaseContract(candidate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      expectedCode,
    );
  });

  it("freezes a detached contract and keeps scope exclusions tied to claim IDs", () => {
    const loaded = expectLoaded(planFixture);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.observationGold.claims)).toBe(true);
    expect(loaded.authorship.reviewScope.atomicObservationClaimIds).toEqual([
      "P1",
    ]);
    expect(loaded.authorship.reviewScope.scopeExclusionIds).toEqual(
      loaded.scopeExclusions.map((exclusion) => exclusion.id),
    );
  });
});
