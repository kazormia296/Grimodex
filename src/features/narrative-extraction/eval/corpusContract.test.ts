import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { validateNarrativeEvalCase } from "./caseSchema";
import { buildNarrativeEvalFixture } from "./fixtureSnapshot";

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

    const allCaseIds = new Set<string>();

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

      expect(corpus.schemaVersion, suite.id).toBe(suite.version);
      expect(corpus.suiteId).toBe(suite.id);
      expect(corpus.cases, suite.id).toHaveLength(suite.caseCount);

      let requiredObservationCount = 0;

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
    }
  });
});
