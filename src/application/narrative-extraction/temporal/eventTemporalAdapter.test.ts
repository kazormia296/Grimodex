import { describe, expect, it } from "vitest";
import { adaptEventTemporalRows } from "./eventTemporalAdapter";

describe("adaptEventTemporalRows", () => {
  it("maps Event endpoints and duration while ignoring ordinal", async () => {
    const result = await adaptEventTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      rows: [
        {
          projectId: "project-1",
          eventId: "event-1",
          narrativeEventId: "ne:event-1",
          ordinal: "zzzz",
          version: 4,
          updatedAt: "2026-08-10T01:02:03.000Z",
          startTime: 10,
          startMinute: 60,
          startGranularity: "time",
          endTime: 11,
          endMinute: 120,
          endGranularity: "time",
          precision: "exact",
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.nodes[0]).toEqual(
      expect.objectContaining({
        id: "tn:event:event-1",
        subject: { kind: "event", eventId: "ne:event-1" },
        shape: "interval",
      }),
    );
    expect(result.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "absolute-window",
          endpoint: "start",
          literal: null,
          resolved: expect.objectContaining({
            startDay: 10,
            endDay: 10,
            startMinute: 60,
            endMinute: 60,
          }),
        }),
        expect.objectContaining({
          kind: "absolute-window",
          endpoint: "end",
          literal: null,
          resolved: expect.objectContaining({
            startDay: 11,
            endDay: 11,
            startMinute: 120,
            endMinute: 120,
          }),
        }),
        expect.objectContaining({
          kind: "duration",
          nodeId: "tn:event:event-1",
          duration: { min: 1500, max: 1500, unit: "minute" },
          authority: "deterministic-derived",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("zzzz");
    expect(result.freshness[0]).toEqual({
      kind: "event",
      id: "event-1",
      version: 4,
      updatedAt: "2026-08-10T01:02:03.000Z",
    });
  });

  it.each([
    {
      label: "approximate precision",
      precision: "approx",
      startGranularity: "time",
      endGranularity: "time",
      startMinute: 60,
      endMinute: 120,
    },
    {
      label: "unknown precision",
      precision: "unknown",
      startGranularity: "day",
      endGranularity: "day",
      startMinute: null,
      endMinute: null,
    },
    {
      label: "mixed granularity",
      precision: "exact",
      startGranularity: "day",
      endGranularity: "time",
      startMinute: null,
      endMinute: 120,
    },
  ])("does not invent an exact duration for $label", async (variant) => {
    const result = await adaptEventTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      rows: [
        {
          projectId: "project-1",
          eventId: "event-1",
          narrativeEventId: "ne:event-1",
          ordinal: "a0",
          version: 1,
          updatedAt: "2026-08-10T01:02:03.000Z",
          startTime: 10,
          startMinute: variant.startMinute,
          startGranularity: variant.startGranularity,
          endTime: 11,
          endMinute: variant.endMinute,
          endGranularity: variant.endGranularity,
          precision: variant.precision,
        },
      ],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.constraints.some((item) => item.kind === "duration")).toBe(
      false,
    );
  });

  it("does not convert an ordinal-only Event into temporal evidence", async () => {
    const result = await adaptEventTemporalRows({
      projectId: "project-1",
      calendar: null,
      rows: [
        {
          projectId: "project-1",
          eventId: "event-1",
          narrativeEventId: "ne:event-1",
          ordinal: "a0",
          version: 0,
          updatedAt: "2026-08-10T01:02:03.000Z",
          startTime: null,
          startMinute: null,
          startGranularity: "none",
          endTime: null,
          endMinute: null,
          endGranularity: "none",
          precision: "exact",
        },
      ],
    });

    expect(result.nodes[0]?.shape).toBe("unknown");
    expect(result.constraints).toEqual([]);
  });

  it("rejects a reversed interval and malformed freshness", async () => {
    const result = await adaptEventTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: "calendar:project-1",
        calendarDigest:
          "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      rows: [
        {
          projectId: "project-1",
          eventId: "event-1",
          narrativeEventId: "ne:event-1",
          ordinal: "a0",
          version: 1.5,
          updatedAt: "",
          startTime: 20,
          startMinute: null,
          startGranularity: "day",
          endTime: 10,
          endMinute: null,
          endGranularity: "day",
          precision: "exact",
        },
      ],
    });

    expect(result.nodes).toEqual([]);
    expect(result.constraints).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("TEMPORAL_ADAPTER_INVALID_ROW");
  });
});
