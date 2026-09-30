import { describe, expect, it } from "vitest";
import type { ThreadDevelopmentInference } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import { buildThreadSignalIndex } from "./signalIndex";

function development(
  overrides: Partial<ThreadDevelopmentInference["payload"]> = {},
): ThreadDevelopmentInference {
  return {
    inferenceId: `inf:${overrides.developmentId ?? "d1"}`,
    kind: "plot.thread-development",
    payload: {
      developmentId: "d1",
      documentRef: "doc:s1",
      sourceEventInferenceIds: [],
      sourceStateInferenceIds: [],
      sourceGoalInferenceIds: [],
      sourceConflictInferenceIds: [],
      sourceQuestionInferenceIds: [],
      advancement: "progresses",
      materiality: "moderate",
      centrality: "secondary",
      explanation: "test",
      ...overrides,
    },
  };
}

describe("buildThreadSignalIndex", () => {
  it("drops non-material developments", () => {
    const index = buildThreadSignalIndex(
      [
        development({
          developmentId: "d1",
          materiality: "minor",
          centrality: "secondary",
        }),
      ],
      { resolveClusterKey: () => "cluster-a" },
    );
    expect(index.entries).toHaveLength(0);
  });

  it("drops developments with unresolved cluster key", () => {
    const index = buildThreadSignalIndex(
      [development({ developmentId: "d1" })],
      {
        resolveClusterKey: () => null,
      },
    );
    expect(index.entries).toHaveLength(0);
  });

  it("groups material developments by resolved cluster key", () => {
    const index = buildThreadSignalIndex(
      [
        development({ developmentId: "d1", documentRef: "doc:s1" }),
        development({ developmentId: "d2", documentRef: "doc:s2" }),
        development({
          developmentId: "d3",
          documentRef: "doc:s3",
          materiality: "major",
        }),
      ],
      {
        resolveClusterKey: (payload) =>
          payload.developmentId === "d3" ? "cluster-b" : "cluster-a",
      },
    );
    expect(index.entries).toHaveLength(3);
    expect(
      index.byClusterKey.get("cluster-a")?.map((e) => e.developmentId),
    ).toEqual(["d1", "d2"]);
    expect(
      index.byClusterKey.get("cluster-b")?.map((e) => e.developmentId),
    ).toEqual(["d3"]);
  });

  it("keeps major/primary developments even when centrality is primary", () => {
    const index = buildThreadSignalIndex(
      [
        development({
          developmentId: "d1",
          materiality: "minor",
          centrality: "primary",
        }),
      ],
      { resolveClusterKey: () => "cluster-a" },
    );
    expect(index.entries).toHaveLength(1);
  });
});
