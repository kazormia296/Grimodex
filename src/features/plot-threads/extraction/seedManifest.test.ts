import { describe, expect, it } from "vitest";
import type { ThreadDevelopmentInference } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import { buildThreadSignalIndex } from "./signalIndex";
import { buildPlotThreadSeedManifest } from "./seedManifest";

function development(
  developmentId: string,
  documentRef: string,
): ThreadDevelopmentInference {
  return {
    inferenceId: `inf:${developmentId}`,
    kind: "plot.thread-development",
    payload: {
      developmentId,
      documentRef,
      sourceEventInferenceIds: [],
      sourceStateInferenceIds: [],
      sourceGoalInferenceIds: [],
      sourceConflictInferenceIds: [],
      sourceQuestionInferenceIds: [],
      advancement: "progresses",
      materiality: "moderate",
      centrality: "secondary",
      explanation: "test",
    },
  };
}

let idCounter = 0;
const createId = () => {
  idCounter += 1;
  return `seed-${idCounter}`;
};

describe("buildPlotThreadSeedManifest", () => {
  it("rejects a single-scene cluster via meetsNewThreadMinimum", () => {
    const index = buildThreadSignalIndex([development("d1", "doc:s1")], {
      resolveClusterKey: () => "cluster-a",
    });
    const manifest = buildPlotThreadSeedManifest(index, {
      createId,
      resolveHasCoreConcern: () => true,
      resolveExactEvidenceSites: () => 2,
    });
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.meetsNewThreadMinimum).toBe(false);
  });

  it("accepts a two-scene cluster with core concern and evidence sites", () => {
    const index = buildThreadSignalIndex(
      [development("d1", "doc:s1"), development("d2", "doc:s2")],
      { resolveClusterKey: () => "cluster-a" },
    );
    const manifest = buildPlotThreadSeedManifest(index, {
      createId,
      resolveHasCoreConcern: () => true,
      resolveExactEvidenceSites: () => 2,
    });
    expect(manifest.entries).toHaveLength(1);
    const entry = manifest.entries[0]!;
    expect(entry.meetsNewThreadMinimum).toBe(true);
    expect(entry.clusterKey).toBe("cluster-a");
    expect([...entry.developmentIds].sort()).toEqual(["d1", "d2"]);
    expect(entry.documentRefs).toEqual(["doc:s1", "doc:s2"]);
  });

  it("rejects when the resolved core concern is missing", () => {
    const index = buildThreadSignalIndex(
      [development("d1", "doc:s1"), development("d2", "doc:s2")],
      { resolveClusterKey: () => "cluster-a" },
    );
    const manifest = buildPlotThreadSeedManifest(index, {
      createId,
      resolveHasCoreConcern: () => false,
      resolveExactEvidenceSites: () => 2,
    });
    expect(manifest.entries[0]?.meetsNewThreadMinimum).toBe(false);
  });

  it("produces one entry per distinct cluster key", () => {
    const index = buildThreadSignalIndex(
      [
        development("d1", "doc:s1"),
        development("d2", "doc:s2"),
        development("d3", "doc:s3"),
        development("d4", "doc:s4"),
      ],
      {
        resolveClusterKey: (payload) =>
          payload.developmentId === "d1" || payload.developmentId === "d2"
            ? "cluster-a"
            : "cluster-b",
      },
    );
    const manifest = buildPlotThreadSeedManifest(index, {
      createId,
      resolveHasCoreConcern: () => true,
      resolveExactEvidenceSites: () => 2,
    });
    expect(manifest.entries.map((e) => e.clusterKey).sort()).toEqual([
      "cluster-a",
      "cluster-b",
    ]);
  });
});
