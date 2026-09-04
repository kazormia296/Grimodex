import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateNarrativeEvalCase } from "./caseSchema";
import { buildNarrativeEvalFixture } from "./fixtureSnapshot";
import { NARRATIVE_EVAL_CASE_SCHEMA_VERSION } from "./types";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

interface NarrativeEvalManifestSuite {
  readonly id: string;
  readonly version: number;
  readonly caseCount: number;
  readonly caseFile: string;
  readonly caseSchema: string;
  readonly requirementIds: readonly string[];
  readonly certification?: {
    readonly diagnosticOnly?: boolean;
  };
}

interface NarrativeEvalCorpus {
  readonly schemaVersion: number;
  readonly suiteId: string;
  readonly cases: readonly unknown[];
}

describe("Chronicle Human Gold corpus", () => {
  it("keeps every manifest suite, JSON Schema, semantic validator, and production Evidence resolver aligned", async () => {
    const manifestSource = await readFile(
      path.join(repoRoot, "evals/narrative/manifest.yaml"),
      "utf8",
    );
    const manifest = yaml.load(manifestSource) as {
      readonly suites: readonly NarrativeEvalManifestSuite[];
    };

    expect(manifest.suites.length).toBeGreaterThan(0);
    expect(new Set(manifest.suites.map((suite) => suite.id)).size).toBe(
      manifest.suites.length,
    );

    const certificationSuite = manifest.suites.find(
      (suite) => suite.id === "chronicle-micro-v1",
    );
    expect(certificationSuite?.caseCount).toBe(14);
    expect(certificationSuite?.certification?.diagnosticOnly ?? false).toBe(
      false,
    );
    expect(certificationSuite?.requirementIds).toEqual([
      "GDX-NARR-EVAL-001",
      "GDX-NARR-EVIDENCE-001",
      "GDX-NARR-SEMANTIC-001",
      "GDX-NARR-COVERAGE-001",
    ]);
    const diagnosticSuite = manifest.suites.find(
      (suite) => suite.id === "chronicle-motif-boundary-v1",
    );
    expect(diagnosticSuite?.caseCount).toBe(5);
    expect(diagnosticSuite?.requirementIds).toEqual([
      "GDX-NARR-EVAL-001",
      "GDX-NARR-EVIDENCE-001",
      "GDX-NARR-SEMANTIC-001",
    ]);
    expect(diagnosticSuite?.certification?.diagnosticOnly).toBe(true);

    const allCaseIds = new Set<string>();
    const caseIdsBySuite = new Map<string, string[]>();

    for (const suite of manifest.suites) {
      const [caseSource, schemaSource] = await Promise.all([
        readFile(
          path.join(repoRoot, "evals/narrative", suite.caseFile),
          "utf8",
        ),
        readFile(
          path.join(repoRoot, "evals/narrative", suite.caseSchema),
          "utf8",
        ),
      ]);
      const corpus = yaml.load(caseSource) as NarrativeEvalCorpus;
      const schema = JSON.parse(schemaSource) as object;
      const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        validateFormats: false,
      });
      const validateSchema = ajv.compile(schema);

      // The corpus schema contract is shared across suites; suite.version is
      // an independent evaluation-suite revision and must not redefine it.
      expect(corpus.schemaVersion, suite.id).toBe(
        NARRATIVE_EVAL_CASE_SCHEMA_VERSION,
      );
      expect(corpus.suiteId).toBe(suite.id);
      expect(corpus.cases, suite.id).toHaveLength(suite.caseCount);

      let requiredObservationCount = 0;
      const suiteCaseIds: string[] = [];

      for (const candidate of corpus.cases) {
        expect(
          validateSchema(candidate),
          `${suite.id}: ${JSON.stringify(validateSchema.errors)}`,
        ).toBe(true);
        const validated = validateNarrativeEvalCase(candidate);
        expect(validated.ok, suite.id).toBe(true);
        if (!validated.ok) continue;

        expect(allCaseIds.has(validated.value.id), validated.value.id).toBe(
          false,
        );
        allCaseIds.add(validated.value.id);
        suiteCaseIds.push(validated.value.id);
        requiredObservationCount +=
          validated.value.expected.observations.required.length;

        const fixture = await buildNarrativeEvalFixture(validated.value);
        expect(
          fixture.goldEvidence.every((entry) => entry.status === "resolved"),
          validated.value.id,
        ).toBe(true);
      }

      // A suite made entirely of negative cases would reward a null extractor.
      // Keep positive recall coverage as a suite-level contract so individual
      // static-description cases may still correctly require no observations.
      expect(requiredObservationCount, suite.id).toBeGreaterThan(0);
      caseIdsBySuite.set(suite.id, suiteCaseIds);
    }

    expect(caseIdsBySuite.get("chronicle-micro-v1")).toEqual([
      "chronicle.micro.actual-gate-collapse-001",
      "chronicle.micro.plan-only-002",
      "chronicle.micro.rumor-only-003",
      "chronicle.micro.blocked-attempt-004",
      "chronicle.micro.dream-only-005",
      "chronicle.micro.hypothetical-only-006",
      "chronicle.micro.flashback-actual-007",
      "chronicle.micro.duplicate-mention-008",
      "chronicle.micro.non-event-description-009",
      "chronicle.micro.exact-quote-selection-010",
      "chronicle.micro.negated-event-011",
      "chronicle.micro.disputed-attribution-012",
      "chronicle.micro.partial-coverage-013",
      "chronicle.micro.significance-gate-014",
    ]);
    expect(caseIdsBySuite.get("chronicle-motif-boundary-v1")).toEqual([
      "chronicle.micro.sword-recovered-015",
      "chronicle.micro.sword-unrecovered-016",
      "chronicle.micro.sword-red-herring-017",
      "chronicle.micro.sword-character-theory-018",
      "chronicle.micro.sword-atmosphere-019",
    ]);
  });
});
