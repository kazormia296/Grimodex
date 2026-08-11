import { describe, expect, it } from "vitest";
import {
  digestStableJson,
  hasLoneSurrogate,
} from "@/features/narrative-extraction/source/digest";
import { adaptSceneTemporalRows } from "./sceneTemporalAdapter";

describe("adaptSceneTemporalRows", () => {
  it("maps persisted Scene time to hard user-metadata constraints with freshness", async () => {
    const result = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      rows: [
        {
          projectId: "project-1",
          sceneId: "scene-1",
          documentRef: "D000001",
          version: 7,
          updatedAt: "2026-08-10T01:02:03.000Z",
          chronicleStartTime: 12,
          chronicleStartMinute: 90,
          chronicleStartGranularity: "time",
          chronicleEndTime: 14,
          chronicleEndMinute: 120,
          chronicleEndGranularity: "time",
          chroniclePrecision: "exact",
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.nodes).toEqual([
      expect.objectContaining({
        id: "tn:scene:scene-1",
        timeline: { kind: "primary" },
        subject: { kind: "scene", documentRef: "D000001" },
        shape: "interval",
      }),
    ]);
    expect(result.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "absolute-window",
          nodeId: "tn:scene:scene-1",
          endpoint: "start",
          literal: null,
          authority: "user-metadata",
          strictness: "hard",
          resolved: expect.objectContaining({
            startDay: 12,
            endDay: 12,
            startMinute: 90,
            endMinute: 90,
          }),
        }),
        expect.objectContaining({
          kind: "absolute-window",
          nodeId: "tn:scene:scene-1",
          endpoint: "end",
          literal: null,
          authority: "user-metadata",
          strictness: "hard",
          resolved: expect.objectContaining({
            startDay: 14,
            endDay: 14,
            startMinute: 120,
            endMinute: 120,
          }),
        }),
      ]),
    );
    expect(result.freshness).toEqual([
      {
        kind: "scene",
        id: "scene-1",
        version: 7,
        updatedAt: "2026-08-10T01:02:03.000Z",
      },
    ]);
  });

  it("keeps an undated Scene as an unknown node without inventing a constraint", async () => {
    const result = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar: null,
      rows: [
        {
          projectId: "project-1",
          sceneId: "scene-1",
          documentRef: "D000001",
          version: 0,
          updatedAt: "2026-08-10T01:02:03.000Z",
          chronicleStartTime: null,
          chronicleStartMinute: null,
          chronicleStartGranularity: "none",
          chronicleEndTime: null,
          chronicleEndMinute: null,
          chronicleEndGranularity: "none",
          chroniclePrecision: "unknown",
        },
      ],
    });

    expect(result.nodes[0]?.shape).toBe("unknown");
    expect(result.constraints).toEqual([]);
  });

  it("folds an exact current projection and uses a point endpoint otherwise", async () => {
    const calendar = {
      calendarRef: "calendar:project-1",
      calendarDigest:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    };
    const row = {
      projectId: "project-1",
      sceneId: "scene-1",
      documentRef: "D000001",
      version: 7,
      updatedAt: "2026-08-10T01:02:03.000Z",
      chronicleStartTime: 12,
      chronicleStartMinute: null,
      chronicleStartGranularity: "day",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
      chroniclePrecision: "exact",
    };
    const valueDigest = await digestStableJson({
      start: { day: 12, minute: null, granularity: "day" },
      end: { day: null, minute: null, granularity: "none" },
      precision: "exact",
    });
    const projection = {
      records: [
        {
          id: "projection-1",
          projectId: "project-1",
          target: { kind: "scene-time" as const, sceneId: "scene-1" },
          constraintSetDigest:
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
          solverVersion: "solver/1",
          calendarDigest: calendar.calendarDigest,
          projectedValueDigest: valueDigest,
          targetResultVersion: 7,
          applicationId: "application-1",
          status: "current" as const,
          version: 0,
        },
      ],
      constraintSetDigest:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as const,
      solverVersion: "solver/1",
    };

    const folded = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar,
      rows: [row],
      projection,
    });
    expect(folded.constraints).toEqual([]);

    const stale = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar,
      rows: [row],
      projection: {
        ...projection,
        records: [
          { ...projection.records[0], targetResultVersion: row.version - 1 },
        ],
      },
    });
    expect(stale.constraints).toEqual([]);
    expect(stale.diagnostics[0]?.code).toBe(
      "TEMPORAL_PROJECTION_VERSION_CHANGED",
    );

    const edited = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar,
      rows: [row],
      projection: {
        ...projection,
        records: [
          {
            ...projection.records[0],
            projectedValueDigest:
              "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          },
        ],
      },
    });
    expect(edited.constraints).toEqual([
      expect.objectContaining({
        kind: "absolute-window",
        endpoint: "point",
        authority: "user-metadata",
      }),
    ]);
    expect(edited.diagnostics[0]?.code).toBe(
      "TEMPORAL_PROJECTION_VALUE_CHANGED",
    );
  });

  it("fails closed for foreign Projects and malformed date tuples", async () => {
    const result = await adaptSceneTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      rows: [
        {
          projectId: "project-2",
          sceneId: "foreign",
          documentRef: "D000001",
          version: 1,
          updatedAt: "2026-08-10T01:02:03.000Z",
          chronicleStartTime: 1,
          chronicleStartMinute: null,
          chronicleStartGranularity: "day",
          chronicleEndTime: null,
          chronicleEndMinute: null,
          chronicleEndGranularity: "none",
          chroniclePrecision: "exact",
        },
        {
          projectId: "project-1",
          sceneId: "malformed",
          documentRef: "D000002",
          version: -1,
          updatedAt: "",
          chronicleStartTime: 1,
          chronicleStartMinute: 1440,
          chronicleStartGranularity: "time",
          chronicleEndTime: null,
          chronicleEndMinute: null,
          chronicleEndGranularity: "none",
          chroniclePrecision: "exact",
        },
      ],
    });

    expect(result.nodes).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "TEMPORAL_ADAPTER_INVALID_ROW",
      "TEMPORAL_ADAPTER_PROJECT_MISMATCH",
    ]);
  });

  it("snapshots caller input before hashing and rejects unsafe identities", async () => {
    const mutableRow = {
      projectId: "project-1",
      sceneId: "scene-1",
      documentRef: "D000001",
      version: 2,
      updatedAt: "2026-08-10T01:02:03.000Z",
      chronicleStartTime: 12,
      chronicleStartMinute: null,
      chronicleStartGranularity: "day",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
      chroniclePrecision: "exact",
    };
    const promise = adaptSceneTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      rows: [
        mutableRow,
        { ...mutableRow, sceneId: "unsafe\ud800", documentRef: "D000002" },
      ],
    });
    mutableRow.version = 99;
    mutableRow.chronicleStartTime = 99;

    const result = await promise;
    expect(result.freshness[0]).toEqual(
      expect.objectContaining({ id: "scene-1", version: 2 }),
    );
    expect(result.constraints[0]).toEqual(
      expect.objectContaining({
        resolved: expect.objectContaining({ startDay: 12 }),
      }),
    );
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "TEMPORAL_ADAPTER_INVALID_ROW",
    ]);
    expect(hasLoneSurrogate(result.diagnostics[0]?.message ?? "")).toBe(false);
    await expect(digestStableJson(result.diagnostics)).resolves.toMatch(
      /^sha256:/,
    );
  });
});
