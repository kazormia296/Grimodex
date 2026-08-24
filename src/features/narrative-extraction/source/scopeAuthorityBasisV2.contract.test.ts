import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv2020, { type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { digestStableJson } from "./digest";
import type { Sha256Digest } from "./types";
import {
  canonicalNarrativeSourceSnapshotRevisionInput,
  canonicalReadingOrderRevisionInput,
  canonicalScopeAuthorityDigestInput,
  canonicalScopeRegistryRevisionInput,
  canonicalStoryTimeOrderRevisionInput,
  computeNarrativeScopeAuthorityBasisDigests,
} from "./scopeAuthorityBasisV2";

type RawMapping = Record<string, unknown> & {
  documentRef?: string;
  readingRank?: number;
  storyTimeOrder?: {
    status?: string;
    reason?: string;
    rawStoryKey?: unknown;
    storyRank?: unknown;
  };
};
type RawDigests = {
  readonly corpusDigest: Sha256Digest;
  readonly scopeRegistryRevision: Sha256Digest;
  readonly readingOrderRevision: Sha256Digest;
  readonly storyTimeOrderRevision: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
  readonly compositeDigest: Sha256Digest;
};
type RawBasis = Record<string, unknown> & {
  source: { sourceKind: string; sourceKey: string };
  mappings: RawMapping[];
  digests: RawDigests;
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
    expect(
      validate({
        ...fixture,
        mappings: fixture.mappings.map((mapping) =>
          mapping.documentRef === "D000001"
            ? {
                ...mapping,
                storyTimeOrder: {
                  status: "resolved",
                  rawStoryKey: "\uE000\n",
                  storyRank: 1,
                },
              }
            : mapping,
        ),
      }),
    ).toBe(false);
    expect(
      validate({
        ...fixture,
        mappings: fixture.mappings.map((mapping) =>
          mapping.documentRef === "D000001"
            ? {
                ...mapping,
                storyTimeOrder: {
                  status: "resolved",
                  rawStoryKey: "\u0085\uE000",
                  storyRank: 1,
                },
              }
            : mapping,
        ),
      }),
    ).toBe(false);
  });

  it("rejects lone UTF-16 surrogates while preserving paired emoji", () => {
    const validate = compileSchema();
    const withMappingField = (field: string, value: string) => ({
      ...fixture,
      mappings: fixture.mappings.map((mapping, index) =>
        index === 0 ? { ...mapping, [field]: value } : mapping,
      ),
    });

    expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...fixture, projectId: "project-\ud800" })).toBe(false);
    expect(
      validate({
        ...fixture,
        source: { ...fixture.source, sourceKey: "snapshot:run-\udc00" },
      }),
    ).toBe(false);
    expect(
      validate(withMappingField("sourceKey", "project:scene:\ud800")),
    ).toBe(false);
    expect(validate(withMappingField("sceneRef", "scene:\udc00"))).toBe(false);
    expect(
      validate(withMappingField("readingOrderRef", "reading:\ud800")),
    ).toBe(false);
    expect(validate(withMappingField("storyTimeRef", "story:\udc00"))).toBe(
      false,
    );
    expect(
      validate({
        ...fixture,
        mappings: fixture.mappings.map((mapping, index) =>
          index === 0
            ? {
                ...mapping,
                storyTimeOrder: {
                  status: "resolved",
                  rawStoryKey: "key-\ud800",
                  storyRank: 1,
                },
              }
            : mapping,
        ),
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
          mapping.documentRef === "D000003"
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
                  rawStoryKey: " \uE000",
                  storyRank: 1,
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
    expect(registry.mappings.map(({ sceneRef }) => sceneRef)).toEqual([
      "scene:scene-five",
      "scene:scene-four",
      "scene:scene-three",
      "scene:\uD83D\uDE00",
      "scene:\uE000",
    ]);
    expect(reading.mappings.map(({ readingRank }) => readingRank)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(reading.mappings.map(({ sceneRef }) => sceneRef)).not.toEqual(
      registry.mappings.map(({ sceneRef }) => sceneRef),
    );
    expect(story.mappings.map(({ storyTimeRef }) => storyTimeRef)).toEqual([
      "story:scene-five",
      "story:scene-four",
      "story:scene-three",
      "story:\uD83D\uDE00",
      "story:\uE000",
    ]);
    expect(
      fixture.mappings
        .filter((mapping) => mapping.storyTimeOrder?.status === "resolved")
        .map((mapping) => [
          mapping.storyTimeOrder?.rawStoryKey,
          mapping.storyTimeOrder?.storyRank,
        ]),
    ).toEqual([
      ["\uE000", 1],
      ["\uD83D\uDE00", 0],
    ]);
    expect(await digestStableJson(story as unknown)).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    const authority = canonicalScopeAuthorityDigestInput(fixture as never, {
      scopeRegistryRevision: fixture.digests.scopeRegistryRevision,
      readingOrderRevision: fixture.digests.readingOrderRevision,
      storyTimeOrderRevision: fixture.digests.storyTimeOrderRevision,
    });
    expect(authority.contractId).toBe("narrative-scope-authority/2");
    expect(authority).toMatchObject({
      basisKind: "historical-run-snapshot",
      projectId: "project-a",
      scopeRegistryRevision: fixture.digests.scopeRegistryRevision,
      readingOrderRevision: fixture.digests.readingOrderRevision,
      storyTimeOrderRevision: fixture.digests.storyTimeOrderRevision,
    });
    expect(
      canonicalNarrativeSourceSnapshotRevisionInput(fixture as never, {
        corpusDigest: fixture.digests.corpusDigest,
        authorityDigest: fixture.digests.authorityDigest,
      }),
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
    await expect(
      computeNarrativeScopeAuthorityBasisDigests(fixture as never),
    ).resolves.toEqual(fixture.digests);
  });

  it("seals one synchronous content snapshot across all five async digests", async () => {
    const mutable = structuredClone(fixture) as RawBasis;
    const pending = computeNarrativeScopeAuthorityBasisDigests(
      mutable as never,
    );

    mutable.source.sourceKey = "snapshot:mutated-during-first-digest";
    mutable.mappings[0].readingRank = 99;
    mutable.mappings[0].storyTimeOrder = {
      status: "resolved",
      rawStoryKey: "mutated-during-first-digest",
      storyRank: 99,
    };

    await expect(pending).resolves.toEqual(fixture.digests);
  });
});
