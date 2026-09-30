import { describe, expect, it } from "vitest";

import type { NarrativeChangeSet } from "@/features/narrative-extraction/maintenance/changeSet";
import type { NarrativeDependencyEdge } from "@/features/narrative-extraction/maintenance/dependency";
import { planMaintenanceImpact } from "./impactPlanner";

const changeSet: NarrativeChangeSet = {
  schemaVersion: 1,
  projectId: "project-1",
  fromExclusiveCanonicalSequence: 0,
  throughInclusiveCanonicalSequence: 2,
  eventIds: ["event-1"],
  objectChanges: [
    {
      objectKey: { kind: "scene", sceneId: "scene-1" },
      before: null,
      after: null,
      mutationKinds: ["update"],
      changedPaths: ["/body"],
      rangeImpacts: [],
      eventIds: ["event-1"],
    },
  ],
  digest: "sha256:change-set",
};

function edge(
  overrides: Partial<NarrativeDependencyEdge> = {},
): NarrativeDependencyEdge {
  return {
    schemaVersion: 1,
    id: "edge-1",
    projectId: "project-1",
    consumer: { kind: "application", applicationId: "application-1" },
    source: {
      kind: "domain-object",
      objectKey: { kind: "scene", sceneId: "scene-1" },
      fieldPaths: ["/body"],
    },
    kind: "evidence-exact",
    expected: {},
    invalidationPolicy: "revalidate-exact",
    digest: "sha256:edge",
    ...overrides,
  };
}

describe("planMaintenanceImpact", () => {
  it("plans matching project-scoped dependencies deterministically", () => {
    const result = planMaintenanceImpact({
      changeSet,
      dependencyEdges: [
        edge({
          id: "edge-b",
          consumer: { kind: "application", applicationId: "b" },
          invalidationPolicy: "manual",
        }),
        edge({
          id: "edge-a",
          consumer: { kind: "application", applicationId: "a" },
        }),
      ],
      budget: { maxTasks: 10, maxDocuments: 10 },
    });

    expect(result.affectedConsumerIds).toEqual([
      '["application","a"]',
      '["application","b"]',
    ]);
    expect(result.mostSeverePolicy).toBe("manual");
    expect(result.budgetDecision.allowed).toBe(true);
  });

  it("rejects a dependency from another project even when it is unaffected", () => {
    expect(() =>
      planMaintenanceImpact({
        changeSet,
        dependencyEdges: [
          edge({
            projectId: "project-2",
            source: {
              kind: "domain-object",
              objectKey: { kind: "scene", sceneId: "other-scene" },
              fieldPaths: [],
            },
          }),
        ],
        budget: { maxTasks: 10, maxDocuments: 10 },
      }),
    ).toThrow("belongs to another project");
  });

  it("reports an over-budget plan without executing it", () => {
    const result = planMaintenanceImpact({
      changeSet,
      dependencyEdges: [edge()],
      budget: { maxTasks: 0, maxDocuments: 0 },
    });

    expect(result.budgetDecision.allowed).toBe(false);
  });
});
