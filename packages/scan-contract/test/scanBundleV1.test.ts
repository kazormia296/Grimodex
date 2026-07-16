import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseEditorSeed,
  parseScanBundle,
  validateChunkExtraction,
  validateScanBundle,
  type EditorSeedV1,
  type ScanBundleV1,
} from "../src/index.js";

async function readFixture(): Promise<unknown> {
  const fixturePath = fileURLToPath(
    new URL("./fixtures/minimal-ja.json", import.meta.url),
  );
  return JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
}

describe("ScanBundleV1 contract", () => {
  it("accepts the minimal Japanese fixture", async () => {
    const result = validateScanBundle(await readFixture());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe("grimodex-scan/1");
      expect(result.value.sections).toHaveLength(1);
    }
  });

  it("returns a typed bundle from parseScanBundle", async () => {
    const result = parseScanBundle(await readFixture());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const bundle: ScanBundleV1 = result.value;
      expect(bundle.entities[0]?.name).toBe("葵");
    }
  });

  it("rejects evidence that points to a missing paragraph", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const sections = fixture.sections as Array<Record<string, unknown>>;
    const entities = fixture.entities as Array<Record<string, unknown>>;
    const evidence = (entities[0]?.evidence ?? []) as Array<
      Record<string, unknown>
    >;
    evidence[0] = {
      ...evidence[0],
      paragraphId: "paragraph:0:9:deadbeef",
    };
    sections[0] = { ...sections[0] };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "missing-reference"),
      ).toBe(true);
    }
  });

  it("rejects chunk events whose paragraph belongs to another section", () => {
    const result = validateChunkExtraction(
      {
        schemaVersion: "grimodex-scan/chunk-extraction/1",
        chunkId: "chunk:test",
        sourceFingerprint: "sha256:test",
        entities: [],
        relations: [],
        events: [
          {
            title: "移動",
            sectionId: "section:0",
            paragraphIds: ["paragraph:0"],
            entityNames: [],
            order: 0,
            evidence: [{ sectionId: "section:0", paragraphId: "paragraph:0" }],
          },
        ],
      },
      {
        paragraphIds: ["paragraph:0"],
        sectionIds: ["section:0", "section:1"],
        paragraphSectionIds: { "paragraph:0": "section:1" },
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "reference-ownership"),
      ).toBe(true);
    }
  });

  it("rejects a chunk event whose section is outside the chunk", () => {
    const result = validateChunkExtraction(
      {
        schemaVersion: "grimodex-scan/chunk-extraction/1",
        chunkId: "chunk:test",
        sourceFingerprint: "sha256:test",
        entities: [],
        relations: [],
        events: [
          {
            title: "移動",
            sectionId: "section:outside",
            paragraphIds: ["paragraph:0"],
            entityNames: [],
            order: 0,
            evidence: [{ sectionId: "section:0", paragraphId: "paragraph:0" }],
          },
        ],
      },
      {
        paragraphIds: ["paragraph:0"],
        sectionIds: ["section:0"],
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (error) =>
            error.code === "missing-reference" &&
            error.path === "/events/0/sectionId",
        ),
      ).toBe(true);
    }
  });

  it("rejects a phase whose anchors move backwards", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const phases = fixture.phases as Array<Record<string, unknown>>;
    phases[0] = {
      ...phases[0],
      anchors: [...(phases[0]?.anchors as unknown[])].reverse(),
    };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "phase-order")).toBe(
        true,
      );
    }
  });

  it("does not throw when an editor seed contains a malformed source paragraph", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const source = fixture.source as Record<string, unknown>;
    source.paragraphs = [null];

    expect(() => parseEditorSeed(fixture)).not.toThrow();
    expect(parseEditorSeed(fixture).ok).toBe(false);
  });

  it("rejects duplicate IDs and relation self-loops", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const entities = fixture.entities as Array<Record<string, unknown>>;
    entities[1] = { ...entities[1], id: entities[0]?.id };
    const relations = fixture.relations as Array<Record<string, unknown>>;
    relations[0] = {
      ...relations[0],
      fromEntityId: entities[0]?.id,
      toEntityId: entities[0]?.id,
    };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "duplicate-id")).toBe(
        true,
      );
      expect(
        result.errors.some((error) => error.code === "relation-self-loop"),
      ).toBe(true);
    }
  });

  it("requires evidence for inferred summary items", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const summary = fixture.summary as Record<string, unknown>;
    const genres = summary.genreCandidates as Array<Record<string, unknown>>;
    genres[0] = { ...genres[0], evidence: [] };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.code === "evidence-required"),
      ).toBe(true);
    }
  });

  it("rejects confirmed findings unless an author action explicitly allows them", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const findings = fixture.findings as Array<Record<string, unknown>>;
    findings[0] = { ...findings[0], status: "confirmed" };

    const fromModel = validateScanBundle(fixture);
    expect(fromModel.ok).toBe(false);

    const afterAuthorAction = validateScanBundle(fixture, {
      allowConfirmedFindingStatus: true,
    });
    expect(afterAuthorAction.ok).toBe(true);
  });

  it("validates a private editor seed against the bundle paragraph set", async () => {
    const bundle = (await readFixture()) as ScanBundleV1;
    const seed: EditorSeedV1 = {
      schemaVersion: "grimodex-scan/editor-seed/1",
      bundle,
      source: {
        schemaVersion: "grimodex-scan/source-document/1",
        title: bundle.source.title,
        language: bundle.source.language,
        fingerprint: bundle.source.fingerprint,
        sections: bundle.sections.map((section) => ({
          id: section.id,
          ordinal: section.ordinal,
          title: section.title,
          paragraphIds: section.paragraphIds,
        })),
        paragraphs: [
          {
            id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
            sectionId:
              "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ordinal: 0,
            text: "葵は灯台の窓を開けた。",
          },
          {
            id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
            sectionId:
              "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ordinal: 1,
            text: "白灯台には古い手紙が残っていた。",
          },
        ],
      },
    };

    expect(parseEditorSeed(seed).ok).toBe(true);
    expect(
      parseEditorSeed({
        ...seed,
        source: { ...seed.source, fingerprint: "sha256:other" },
      }).ok,
    ).toBe(false);
  });

  it("rejects a source paragraph mutation even when the old fingerprint is retained", async () => {
    const bundle = (await readFixture()) as ScanBundleV1;
    const source = {
      schemaVersion: "grimodex-scan/source-document/1" as const,
      title: bundle.source.title,
      language: bundle.source.language,
      fingerprint: bundle.source.fingerprint,
      sections: bundle.sections.map((section) => ({ ...section })),
      paragraphs: [
        {
          id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 0,
          text: "本文を書き換えた。",
        },
        {
          id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 1,
          text: "白灯台には古い手紙が残っていた。",
        },
      ],
    };

    const result = parseEditorSeed({
      schemaVersion: "grimodex-scan/editor-seed/1",
      bundle,
      source,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (item) => item.code === "fingerprint-content-mismatch",
        ),
      ).toBe(true);
    }
  });

  it("rejects source sections whose order or paragraph ownership differs", async () => {
    const bundle = (await readFixture()) as ScanBundleV1;
    const seed = {
      schemaVersion: "grimodex-scan/editor-seed/1" as const,
      bundle,
      source: {
        schemaVersion: "grimodex-scan/source-document/1" as const,
        title: bundle.source.title,
        language: bundle.source.language,
        fingerprint: bundle.source.fingerprint,
        sections: bundle.sections.map((section) => ({
          ...section,
          paragraphIds: [...section.paragraphIds].reverse(),
        })),
        paragraphs: [
          {
            id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
            sectionId:
              "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ordinal: 0,
            text: "葵は灯台の窓を開けた。",
          },
          {
            id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
            sectionId:
              "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ordinal: 1,
            text: "白灯台には古い手紙が残っていた。",
          },
        ],
      },
    };

    expect(parseEditorSeed(seed).ok).toBe(false);
  });

  it("rejects evidence excerpts and sentence indexes that do not match source text", async () => {
    const bundle = (await readFixture()) as ScanBundleV1;
    const findings = bundle.findings.map((finding) => ({
      ...finding,
      evidence: [
        {
          ...finding.evidence[0],
          sentenceIndex: 99,
          excerpt: "本文に存在しない抜粋",
        },
      ],
    }));
    const source = {
      schemaVersion: "grimodex-scan/source-document/1" as const,
      title: bundle.source.title,
      language: bundle.source.language,
      fingerprint: bundle.source.fingerprint,
      sections: bundle.sections.map((section) => ({ ...section })),
      paragraphs: [
        {
          id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 0,
          text: "葵は灯台の窓を開けた。",
        },
        {
          id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 1,
          text: "白灯台には古い手紙が残っていた。",
        },
      ],
    };

    const result = parseEditorSeed({
      schemaVersion: "grimodex-scan/editor-seed/1",
      bundle: { ...bundle, findings },
      source,
    });

    expect(result.ok).toBe(false);
  });

  it("validates chunk extraction independently before merge", () => {
    const result = validateChunkExtraction(
      {
        schemaVersion: "grimodex-scan/chunk-extraction/1",
        chunkId: "chunk:fixture",
        sourceFingerprint: "sha256:fixture-minimal-ja",
        entities: [],
        relations: [],
        events: [],
      },
      {
        expectedChunkId: "chunk:fixture",
        expectedSourceFingerprint: "sha256:fixture-minimal-ja",
        paragraphIds: [],
      },
    );

    expect(result.ok).toBe(true);
    expect(
      validateChunkExtraction(
        {
          schemaVersion: "grimodex-scan/chunk-extraction/1",
          chunkId: "chunk:fixture",
          sourceFingerprint: "sha256:fixture-minimal-ja",
          entities: [],
          relations: [],
          events: [],
        },
        {
          expectedChunkId: "chunk:other",
          expectedSourceFingerprint: "sha256:fixture-minimal-ja",
          paragraphIds: [],
        },
      ).ok,
    ).toBe(false);
  });

  it("rejects non-candidate statuses other than an explicitly confirmed finding", async () => {
    const fixture = (await readFixture()) as ScanBundleV1;
    const rejected = {
      ...fixture,
      findings: fixture.findings.map((finding) => ({
        ...finding,
        status: "rejected" as const,
      })),
    };

    expect(
      validateScanBundle(rejected, { allowConfirmedFindingStatus: true }).ok,
    ).toBe(false);
  });
});
