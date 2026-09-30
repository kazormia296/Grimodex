import { describe, expect, it } from "vitest";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import {
  matchChronicleEventTitleAgainstCatalog,
  matchExistingChronicleEvent,
  type ExistingChronicleEventCatalogRecord,
} from "./existingEventMatcher";

function hypothesis(overrides: Partial<EventHypothesis> = {}): EventHypothesis {
  return {
    hypothesisId: "hyp-1",
    clusterRef: "cluster-0001",
    observationRefs: ["obs-1"],
    titleSuggestion: "教会への砲撃",
    summary: "教会が砲撃された",
    actuality: "actual",
    significance: "major",
    ...overrides,
  };
}

function catalog(
  overrides: Partial<ExistingChronicleEventCatalogRecord> = {},
): ExistingChronicleEventCatalogRecord {
  return {
    ref: "existing-1",
    sourceKey: "event:existing-1",
    title: "教会への砲撃",
    note: null,
    version: 1,
    linkedDocumentSourceKeys: ["project:scene:a"],
    participantEntityRefs: [],
    startTime: null,
    endTime: null,
    digest: `sha256:${"a".repeat(64)}`,
    ...overrides,
  };
}

describe("matchExistingChronicleEvent", () => {
  it("returns none when catalog is empty", () => {
    expect(
      matchExistingChronicleEvent(
        {
          hypothesis: hypothesis(),
          evidenceDocumentSourceKeys: ["project:scene:a"],
        },
        [],
      ),
    ).toEqual({ status: "none" });
  });

  it("marks application provenance hits as already-satisfied", () => {
    const result = matchExistingChronicleEvent(
      {
        hypothesis: hypothesis(),
        evidenceDocumentSourceKeys: [],
        provenanceKeys: ["S0001\0教会の尖塔が崩れ落ちた。"],
      },
      [
        catalog({
          applicationProvenanceKeys: ["S0001\0教会の尖塔が崩れ落ちた。"],
        }),
      ],
    );
    expect(result).toEqual({
      status: "already-satisfied",
      existingRef: "existing-1",
    });
  });

  it("marks title + scene-set matches as already-satisfied", () => {
    const result = matchExistingChronicleEvent(
      {
        hypothesis: hypothesis(),
        evidenceDocumentSourceKeys: ["project:scene:a"],
      },
      [catalog()],
    );
    expect(result).toEqual({
      status: "already-satisfied",
      existingRef: "existing-1",
    });
  });

  it("treats title-only matches as probable-duplicate and never auto-skips", () => {
    const result = matchExistingChronicleEvent(
      {
        hypothesis: hypothesis(),
        evidenceDocumentSourceKeys: ["project:scene:other"],
      },
      [catalog()],
    );
    expect(result).toEqual({
      status: "probable-duplicate",
      candidates: ["existing-1"],
      reasons: ["title-only"],
    });
  });
});

describe("matchChronicleEventTitleAgainstCatalog", () => {
  it("returns every normalized title hit as an explicit probable duplicate", () => {
    expect(
      matchChronicleEventTitleAgainstCatalog("  教会への砲撃  ", [
        catalog(),
        catalog({ ref: "existing-2", title: "教会への砲撃" }),
      ]),
    ).toEqual({
      status: "probable-duplicate",
      candidates: ["existing-1", "existing-2"],
      reasons: ["title-only"],
    });
  });

  it("returns none when the sealed catalog has no title hit", () => {
    expect(
      matchChronicleEventTitleAgainstCatalog("撤退命令", [catalog()]),
    ).toEqual({ status: "none" });
  });
});
