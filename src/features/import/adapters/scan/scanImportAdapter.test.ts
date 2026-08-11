import { describe, it, expect } from "vitest";
import { scanImportAdapter } from "./scanImportAdapter";
import type { ScanBundleV1 } from "@grimodex/scan-contract";

function minimalScanBundle(): ScanBundleV1 {
  return {
    schemaVersion: "grimodex-scan/1",
    source: {
      title: "Sample",
      language: "ja",
      fingerprint: "scan-fp-1",
      characterCount: 10,
      paragraphCount: 1,
      sectionCount: 1,
    },
    sections: [
      {
        id: "sec-1",
        ordinal: 0,
        title: "Chapter 1",
        paragraphIds: ["p-1"],
      },
    ],
    entities: [
      {
        id: "ent-1",
        type: "character",
        name: "Alice",
        aliases: [],
        confidence: 0.9,
        evidence: [],
      },
    ],
    relations: [],
    phases: [],
    events: [],
    findings: [],
    summary: {
      genreCandidates: [],
      themes: [],
      strengths: [],
      risks: [],
    },
    provenance: {
      pipelineVersion: "test",
      promptVersions: {},
      models: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("scanImportAdapter", () => {
  it("maps scan bundle sections to documents and entities to codex records", async () => {
    const result = await Promise.resolve(
      scanImportAdapter.parse({
        kind: "scan-bundle",
        label: "bundle.json",
        data: minimalScanBundle(),
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.draft?.nodes).toHaveLength(1);
    expect(result.draft?.documents).toHaveLength(1);
    expect(result.draft?.structure.codexEntries).toHaveLength(1);
    expect(result.draft?.structure.codexEntries[0]?.origin).toBe(
      "external-analysis",
    );
    expect(result.draft?.identity.fingerprint).toBe("scan-fp-1");
  });

  it("returns diagnostics for unsupported input", async () => {
    const result = await Promise.resolve(
      scanImportAdapter.parse({
        kind: "scan-bundle",
        label: "bad.json",
        data: { foo: "bar" },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("unsupported-input");
  });
});
