import { describe, expect, it } from "vitest";
import {
  matchExistingPlotThread,
  type ExistingPlotThreadCatalogRecord,
} from "./existingThreadMatcher";

function catalog(
  overrides: Partial<ExistingPlotThreadCatalogRecord> = {},
): ExistingPlotThreadCatalogRecord {
  return {
    ref: "PT0001",
    name: "王位継承の陰謀",
    coreKind: "conflict",
    markerDocumentRefs: ["doc:s1", "doc:s2"],
    ...overrides,
  };
}

describe("matchExistingPlotThread", () => {
  it("returns none when catalog is empty", () => {
    expect(
      matchExistingPlotThread(
        {
          nameSuggestion: "王位継承の陰謀",
          coreKind: "conflict",
          markerDocumentRefs: ["doc:s1"],
        },
        [],
      ),
    ).toEqual({ status: "none" });
  });

  it("resolves via application provenance regardless of name", () => {
    const result = matchExistingPlotThread(
      {
        nameSuggestion: "別名で提案された同じスレッド",
        coreKind: "conflict",
        markerDocumentRefs: [],
        provenanceKeys: ["bind:PT0001:hash-abc"],
      },
      [
        catalog({
          applicationProvenanceKeys: ["bind:PT0001:hash-abc"],
        }),
      ],
    );
    expect(result).toEqual({
      status: "resolved",
      ref: "PT0001",
      method: "application-provenance",
    });
  });

  it("resolves via name + core kind + shared marker document", () => {
    const result = matchExistingPlotThread(
      {
        nameSuggestion: "王位継承の陰謀",
        coreKind: "conflict",
        markerDocumentRefs: ["doc:s2", "doc:s3"],
      },
      [catalog()],
    );
    expect(result).toEqual({
      status: "resolved",
      ref: "PT0001",
      method: "core-and-marker-overlap",
    });
  });

  it("treats name-only matches as ambiguous and never auto-binds", () => {
    const result = matchExistingPlotThread(
      {
        nameSuggestion: "王位継承の陰謀",
        coreKind: "conflict",
        markerDocumentRefs: ["doc:other"],
      },
      [catalog()],
    );
    expect(result).toEqual({
      status: "ambiguous",
      candidates: [
        {
          ref: "PT0001",
          score: 0.6,
          reasons: ["name-only", "core-kind-match"],
        },
      ],
    });
  });

  it("lowers score when core kind differs on a name-only match", () => {
    const result = matchExistingPlotThread(
      {
        nameSuggestion: "王位継承の陰謀",
        coreKind: "process",
        markerDocumentRefs: ["doc:other"],
      },
      [catalog()],
    );
    expect(result).toEqual({
      status: "ambiguous",
      candidates: [
        {
          ref: "PT0001",
          score: 0.4,
          reasons: ["name-only"],
        },
      ],
    });
  });

  it("normalizes name casing/whitespace before matching", () => {
    const result = matchExistingPlotThread(
      {
        nameSuggestion: "  王位継承の陰謀  ",
        coreKind: "conflict",
        markerDocumentRefs: ["doc:s1"],
      },
      [catalog()],
    );
    expect(result.status).toBe("resolved");
  });
});
