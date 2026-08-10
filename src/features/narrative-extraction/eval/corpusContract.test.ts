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

describe("Chronicle Human Gold corpus", () => {
  it("keeps manifest, JSON Schema, semantic validator, and production Evidence resolver aligned", async () => {
    const [manifestSource, caseSource, schemaSource] = await Promise.all([
      readFile(path.join(repoRoot, "evals/narrative/manifest.yaml"), "utf8"),
      readFile(
        path.join(repoRoot, "evals/narrative/cases/chronicle-micro-v1.yaml"),
        "utf8",
      ),
      readFile(
        path.join(repoRoot, "evals/narrative/schemas/case-v1.schema.json"),
        "utf8",
      ),
    ]);
    const manifest = yaml.load(manifestSource) as {
      suites: Array<{ id: string; caseCount: number }>;
    };
    const corpus = yaml.load(caseSource) as {
      schemaVersion: number;
      suiteId: string;
      cases: unknown[];
    };
    const schema = JSON.parse(schemaSource) as object;
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validateSchema = ajv.compile(schema);

    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.cases).toHaveLength(14);
    expect(
      manifest.suites.find((suite) => suite.id === corpus.suiteId)?.caseCount,
    ).toBe(corpus.cases.length);

    for (const candidate of corpus.cases) {
      expect(
        validateSchema(candidate),
        JSON.stringify(validateSchema.errors),
      ).toBe(true);
      const validated = validateNarrativeEvalCase(candidate);
      expect(validated.ok).toBe(true);
      if (!validated.ok) continue;
      const fixture = await buildNarrativeEvalFixture(validated.value);
      expect(
        fixture.goldEvidence.every((entry) => entry.status === "resolved"),
      ).toBe(true);
    }
  });
});
