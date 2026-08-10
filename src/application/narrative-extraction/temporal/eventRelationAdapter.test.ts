import { describe, expect, it } from "vitest";
import { adaptEventRelationRows } from "./eventRelationAdapter";

describe("adaptEventRelationRows", () => {
  it("maps cause to effect as a hard before-or-equal relation", async () => {
    const result = await adaptEventRelationRows({
      projectId: "project-1",
      rows: [
        {
          projectId: "project-1",
          causeEventId: "cause",
          effectEventId: "effect",
          causeVersion: 3,
          causeUpdatedAt: "2026-08-10T01:02:03.000Z",
          effectVersion: 4,
          effectUpdatedAt: "2026-08-10T01:02:04.000Z",
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.constraints).toEqual([
      expect.objectContaining({
        kind: "interval-relation",
        leftNodeId: "tn:event:cause",
        relation: "before-or-equal",
        rightNodeId: "tn:event:effect",
        authority: "existing-domain-relation",
        strictness: "hard",
      }),
    ]);
    expect(result.freshness).toEqual([
      {
        kind: "event-relation",
        id: "event-relation:cause:effect",
        endpointVersions: [
          {
            eventId: "cause",
            version: 3,
            updatedAt: "2026-08-10T01:02:03.000Z",
          },
          {
            eventId: "effect",
            version: 4,
            updatedAt: "2026-08-10T01:02:04.000Z",
          },
        ],
      },
    ]);
  });

  it("rejects self, foreign, and malformed relations", async () => {
    const base = {
      projectId: "project-1",
      causeVersion: 0,
      causeUpdatedAt: "2026-08-10T01:02:03.000Z",
      effectVersion: 0,
      effectUpdatedAt: "2026-08-10T01:02:03.000Z",
    };
    const result = await adaptEventRelationRows({
      projectId: "project-1",
      rows: [
        { ...base, causeEventId: "same", effectEventId: "same" },
        {
          ...base,
          projectId: "project-2",
          causeEventId: "a",
          effectEventId: "b",
        },
        {
          ...base,
          causeVersion: -1,
          causeEventId: "a",
          effectEventId: "b",
        },
        { ...base, causeEventId: "unsafe\ud800", effectEventId: "b" },
      ],
    });

    expect(result.constraints).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "TEMPORAL_ADAPTER_INVALID_ROW",
      "TEMPORAL_ADAPTER_INVALID_ROW",
      "TEMPORAL_ADAPTER_INVALID_ROW",
      "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
    ]);
  });

  it("uses an unambiguous tuple identity for relation freshness", async () => {
    const base = {
      projectId: "project-1",
      causeVersion: 0,
      causeUpdatedAt: "2026-08-10T01:02:03.000Z",
      effectVersion: 0,
      effectUpdatedAt: "2026-08-10T01:02:03.000Z",
    };
    const result = await adaptEventRelationRows({
      projectId: "project-1",
      rows: [
        { ...base, causeEventId: "a->b", effectEventId: "c" },
        { ...base, causeEventId: "a", effectEventId: "b->c" },
      ],
    });

    expect(result.constraints).toHaveLength(2);
    expect(new Set(result.freshness.map((item) => item.id)).size).toBe(2);
  });
});
