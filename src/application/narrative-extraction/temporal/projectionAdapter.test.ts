import { describe, expect, it } from "vitest";
import {
  classifyTemporalProjection,
  type CurrentTemporalProjectionValue,
  type TemporalProjectionRecord,
} from "./projectionAdapter";

describe("classifyTemporalProjection", () => {
  const current = {
    projectId: "project-1",
    target: { kind: "scene-time" as const, sceneId: "scene-1" },
    resultVersion: 4,
    valueDigest: "sha256:current",
    constraintSetDigest: "sha256:constraints",
    solverVersion: "solver/1",
    calendarDigest: "sha256:calendar",
  } satisfies CurrentTemporalProjectionValue;
  const record = {
    id: "projection-1",
    projectId: "project-1",
    target: current.target,
    constraintSetDigest: current.constraintSetDigest,
    solverVersion: current.solverVersion,
    calendarDigest: current.calendarDigest,
    projectedValueDigest: current.valueDigest,
    targetResultVersion: current.resultVersion,
    applicationId: "application-1",
    status: "current" as const,
    version: 0,
  } satisfies TemporalProjectionRecord;
  const staleProjectionCases: readonly (readonly [
    TemporalProjectionRecord,
    string,
  ])[] = [
    [
      { ...record, status: "invalidated" as const },
      "TEMPORAL_PROJECTION_NOT_CURRENT",
    ],
    [
      { ...record, targetResultVersion: 3 },
      "TEMPORAL_PROJECTION_VERSION_CHANGED",
    ],
    [
      { ...record, constraintSetDigest: "sha256:old" },
      "TEMPORAL_PROJECTION_SOURCE_CHANGED",
    ],
  ];

  it("folds only a fully current materialization into its source constraints", () => {
    expect(classifyTemporalProjection({ current, record })).toEqual({
      folded: true,
      authority: "projection-derived",
      diagnostic: null,
    });
  });

  it.each(staleProjectionCases)(
    "folds an unchanged but stale materialization with a diagnostic",
    (candidate, code) => {
      const result = classifyTemporalProjection({ current, record: candidate });
      expect(result.folded).toBe(true);
      expect(result.authority).toBe("projection-derived");
      expect(result.diagnostic?.code).toBe(code);
    },
  );

  it.each([
    [
      { ...record, projectedValueDigest: "sha256:changed" as const },
      "TEMPORAL_PROJECTION_VALUE_CHANGED",
    ],
    [
      { ...record, projectId: "project-2" },
      "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
    ],
  ] satisfies readonly (readonly [TemporalProjectionRecord, string])[])(
    "keeps edited or unrelated values as user metadata",
    (candidate, code) => {
      const result = classifyTemporalProjection({ current, record: candidate });
      expect(result.folded).toBe(false);
      expect(result.authority).toBe("user-metadata");
      expect(result.diagnostic?.code).toBe(code);
    },
  );

  it("treats a missing record as ordinary user metadata without a diagnostic", () => {
    expect(classifyTemporalProjection({ current, record: null })).toEqual({
      folded: false,
      authority: "user-metadata",
      diagnostic: null,
    });
  });
});
