import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { digestStableJson, stableJsonStringify } from "./digest";
import {
  canonicalNarrativeSnapshotV2DigestInput,
  canonicalReadingOrderRevisionInput,
  canonicalStoryTimeOrderRevisionInput,
  validateNarrativeScopeAuthorityBasis,
} from "./scopeAuthorityBasis";

const fixture = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "policies/narrative/fixtures/scope-authority-basis-v1.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

const snapshotDocuments = [
  {
    ref: "D000001",
    sourceKey: "project:scene:scene-one",
    origin: {kind: "project-node", nodeId: "scene-one"},
  },
  {
    ref: "D000002",
    sourceKey: "project:scene:scene-two",
    origin: {kind: "project-node", nodeId: "scene-two"},
  },
  {
    ref: "D000003",
    sourceKey: "project:scene:scene-three",
    origin: {kind: "project-node", nodeId: "scene-three"},
  },
];

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    ...fixture,
    entries: (fixture.entries as readonly Record<string, unknown>[]).map(
      (entry) => ({...entry}),
    ),
    ...overrides,
  };
}

describe("NIR-0 source.snapshot@2 scope authority basis contract", () => {
  it("accepts the valid TS/Rust golden and exact document coverage", () => {
    expect(
      validateNarrativeScopeAuthorityBasis(fixture, {documents: snapshotDocuments}),
    ).toEqual({valid: true});
  });

  it("rejects source.snapshot@1 being presented as scope authority", () => {
    expect(
      validateNarrativeScopeAuthorityBasis(
        {contractId: "source.snapshot@1", schemaVersion: 1},
        {documents: snapshotDocuments},
      ),
    ).toMatchObject({valid: false, reason: "unsupported-contract"});
  });

  it("rejects unknown fields, mapping drift, reading gaps, and duplicate reading indexes", () => {
    expect(
      validateNarrativeScopeAuthorityBasis(
        candidate({unknown: true}),
        {documents: snapshotDocuments},
      ),
    ).toMatchObject({valid: false, reason: "unknown-field"});

    const mappingMismatch = candidate({
      entries: (fixture.entries as readonly Record<string, unknown>[]).map(
        (entry, index) =>
          index === 0
            ? {...entry, sceneRef: "scene:other"}
            : {...entry},
      ),
    });
    expect(
      validateNarrativeScopeAuthorityBasis(mappingMismatch, {
        documents: snapshotDocuments,
      }),
    ).toMatchObject({valid: false, reason: "mapping-mismatch"});

    for (const entries of [
      [
        ...(fixture.entries as readonly Record<string, unknown>[]),
      ].map((entry, index) =>
        index === 2 ? {...entry, readingOrderIndex: 3} : {...entry},
      ),
      [
        ...(fixture.entries as readonly Record<string, unknown>[]),
      ].map((entry, index) =>
        index === 2 ? {...entry, readingOrderIndex: 1} : {...entry},
      ),
    ]) {
      expect(
        validateNarrativeScopeAuthorityBasis(candidate({entries}), {
          documents: snapshotDocuments,
        }),
      ).toMatchObject({valid: false, reason: "reading-order-not-contiguous"});
    }
  });

  it("requires the fixed registry and reader audience reservation", () => {
    expect(
      validateNarrativeScopeAuthorityBasis(
        candidate({scopeRegistryVersion: "narrative-scope/3"}),
        {documents: snapshotDocuments},
      ),
    ).toMatchObject({valid: false, reason: "unsupported-registry"});
    expect(
      validateNarrativeScopeAuthorityBasis(
        candidate({reservedAudienceRefs: ["author"]}),
        {documents: snapshotDocuments},
      ),
    ).toMatchObject({valid: false, reason: "reserved-audience-mismatch"});
  });

  it("keeps story-time unresolved and forbids fallback or unsupported reasons", () => {
    const fallback = candidate({
      entries: (fixture.entries as readonly Record<string, unknown>[]).map(
        (entry, index) =>
          index === 1
            ? {...entry, storyTime: {kind: "resolved", orderIndex: 1}}
            : {...entry},
      ),
    });
    expect(
      validateNarrativeScopeAuthorityBasis(fallback, {documents: snapshotDocuments}),
    ).toMatchObject({valid: false, reason: "story-time-fallback-forbidden"});

    const unsupported = candidate({
      entries: (fixture.entries as readonly Record<string, unknown>[]).map(
        (entry, index) =>
          index === 1
            ? {...entry, storyTime: {kind: "unresolved", reason: "legacy-axis-unknown"}}
            : {...entry},
      ),
    });
    expect(
      validateNarrativeScopeAuthorityBasis(unsupported, {
        documents: snapshotDocuments,
      }),
    ).toMatchObject({valid: false, reason: "unsupported-story-time-reason"});
  });

  it("separates reading-only and story-only digest domains", async () => {
    const readingInput = canonicalReadingOrderRevisionInput(fixture);
    const storyInput = canonicalStoryTimeOrderRevisionInput(fixture);
    const readingChanged = candidate({
      entries: (fixture.entries as readonly Record<string, unknown>[]).map(
        (entry, index) =>
          index === 0 ? {...entry, readingOrderIndex: 2} : {...entry},
      ),
    });
    const storyChanged = candidate({
      entries: (fixture.entries as readonly Record<string, unknown>[]).map(
        (entry, index) =>
          index === 0
            ? {...entry, storyTime: {kind: "resolved", orderIndex: 7}}
            : {...entry},
      ),
    });

    expect(canonicalReadingOrderRevisionInput(readingChanged)).not.toEqual(
      readingInput,
    );
    expect(canonicalStoryTimeOrderRevisionInput(readingChanged)).toEqual(
      storyInput,
    );
    expect(canonicalStoryTimeOrderRevisionInput(storyChanged)).not.toEqual(
      storyInput,
    );
    expect(canonicalReadingOrderRevisionInput(storyChanged)).toEqual(
      readingInput,
    );
    expect(stableJsonStringify(canonicalReadingOrderRevisionInput(fixture))).toContain(
      '"axis":"reading-order"',
    );
    expect(
      await digestStableJson(canonicalStoryTimeOrderRevisionInput(fixture)),
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("binds v2 snapshot digest to the v1 corpus digest plus authority digest", () => {
    expect(
      canonicalNarrativeSnapshotV2DigestInput(
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      ),
    ).toEqual({
      contractId: "source.snapshot/2",
      corpusDigest:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      scopeAuthorityDigest:
        "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    });
  });

  it("does not turn the generic artifact route into an @2 authority claim", () => {
    const artifactPolicy = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "policies/narrative/narrative-artifact-authority.json"),
        "utf8",
      ),
    ) as {artifacts: readonly Record<string, unknown>[]; implementationStatus: Record<string, unknown>};
    const reserved = artifactPolicy.artifacts.find(
      (artifact) => artifact.id === "scope-authority-basis",
    );
    expect(reserved).toBeUndefined();
    expect(artifactPolicy.implementationStatus).toMatchObject({
      state: "wired",
    });
  });
});
