import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { digestStableJson } from "./digest";
import {
  canonicalNarrativeSourceSnapshotRevisionInput,
  canonicalReadingOrderRevisionInput,
  canonicalScopeRegistryRevisionInput,
  canonicalStoryTimeOrderRevisionInput,
} from "./scopeAuthorityBasisV2";

type RawMapping = Record<string, unknown> & {
  readonly documentRef?: string;
  readonly storyTimeOrder?: unknown;
};
type RawBasis = Record<string, unknown> & {
  readonly mappings: readonly RawMapping[];
  readonly digests: Record<string, unknown>;
};

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "policies/narrative/fixtures/narrative-ir/scope-authority-basis-v2.json",
    ),
    "utf8",
  ),
) as RawBasis;

function compileSchema() {
  const schema = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        "policies/narrative/schemas/narrative-scope-authority-basis-v2.schema.json",
      ),
      "utf8",
    ),
  ) as AnySchema;
  return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
}

describe("NIR-0 scope authority basis v2 schema contract", () => {
  it("accepts the shared semantic basis golden through AJV", () => {
    const validate = compileSchema();
    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects @1 and unknown fields at both root and nested story levels", () => {
    const validate = compileSchema();
    expect(validate({ ...fixture, contractId: "source.snapshot@1" })).toBe(
      false,
    );
    expect(validate({ ...fixture, unknown: true })).toBe(false);
    expect(
      validate({
        ...fixture,
        mappings: [
          {
            ...fixture.mappings[0],
            storyTimeOrder: {
              status: "resolved",
              rawStoryKey: "a0",
              storyRank: 0,
              unknown: true,
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("fixes registry/audience and story union shape without permitting fallback", () => {
    const validate = compileSchema();
    expect(
      validate({
        ...fixture,
        scopeRegistry: {
          registryVersion: "narrative-scope/3",
          reservedAudienceRefs: ["reader"],
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        scopeRegistry: {
          registryVersion: "narrative-scope/2",
          reservedAudienceRefs: ["author"],
        },
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        mappings: fixture.mappings.map((mapping) =>
          mapping.documentRef === "D000002"
            ? {
                ...mapping,
                storyTimeOrder: {
                  status: "unresolved",
                  reason: "not-provided",
                  rawStoryKey: "must-not-fallback",
                },
              }
            : mapping,
        ),
      }),
    ).toBe(false);
  });

  it("requires exact raw-key spelling and explicit ambiguous duplicate representation", () => {
    const validate = compileSchema();
    expect(
      validate({
        ...fixture,
        mappings: fixture.mappings.map((mapping) =>
          mapping.documentRef === "D000001"
            ? {
                ...mapping,
                storyTimeOrder: {
                  status: "resolved",
                  rawStoryKey: " a0",
                  storyRank: 0,
                },
              }
            : mapping,
        ),
      }),
    ).toBe(false);
    expect(
      fixture.mappings.find((mapping) => mapping.documentRef === "D000004")
        ?.storyTimeOrder,
    ).toEqual({ status: "unresolved", reason: "ambiguous", rawStoryKey: "b0" });
  });

  it("keeps every digest domain explicit and exposes the carrier revision input", async () => {
    const registry = canonicalScopeRegistryRevisionInput(fixture as never);
    const reading = canonicalReadingOrderRevisionInput(fixture as never);
    const story = canonicalStoryTimeOrderRevisionInput(fixture as never);
    expect(registry.contractId).toBe("narrative-scope-registry-revision/1");
    expect(reading.contractId).toBe("narrative-reading-order-revision/1");
    expect(story.contractId).toBe("narrative-story-time-order-revision/1");
    expect(registry.mappings).toHaveLength(fixture.mappings.length);
    expect(reading.mappings).toHaveLength(fixture.mappings.length);
    expect(story.mappings).toHaveLength(fixture.mappings.length);
    expect(await digestStableJson(story as unknown)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(
      canonicalNarrativeSourceSnapshotRevisionInput(fixture as never),
    ).toEqual({
      contractId: "narrative-source-snapshot-revision/2",
      basisKind: "historical-run-snapshot",
      projectId: "project-a",
      source: {
        sourceKind: "snapshot-document",
        sourceKey: "snapshot:run-a",
      },
      corpusDigest: fixture.digests.corpusDigest,
      authorityDigest: fixture.digests.authorityDigest,
    });
  });
});
