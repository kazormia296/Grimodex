import { describe, expect, it } from "vitest";
import { buildExtractionCalendarSnapshot } from "@/features/chronicle/calendar/extractionCalendarSnapshot";
import { buildTemporalConstraintGraph } from "@/features/narrative-extraction/temporal/graph";
import { adaptEventRelationRows } from "./eventRelationAdapter";
import { adaptEventTemporalRows } from "./eventTemporalAdapter";

describe("Temporal Domain adapters", () => {
  it("builds a valid graph from point Events and a cause/effect relation", async () => {
    const calendarResult = await buildExtractionCalendarSnapshot({
      version: 1,
      startYear: 1,
      daysPerYear: 360,
      months: "[]",
      seasonBoundaries: "[]",
      eras: "[]",
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: '{"kind":"none"}',
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 0,
    });
    if (!calendarResult.ok) {
      throw new Error(JSON.stringify(calendarResult.diagnostics));
    }
    const calendar = calendarResult.snapshot;
    const eventRows = ["cause", "effect"].map((eventId, index) => ({
      projectId: "project-1",
      eventId,
      narrativeEventId: eventId,
      ordinal: String(index),
      version: 1,
      updatedAt: "2026-08-10T01:02:03.000Z",
      startTime: 10 + index,
      startMinute: null,
      startGranularity: "day",
      endTime: null,
      endMinute: null,
      endGranularity: "none",
      precision: "exact",
    }));
    const events = await adaptEventTemporalRows({
      projectId: "project-1",
      calendar: {
        calendarRef: calendar.calendarRef,
        calendarDigest: calendar.digest,
      },
      rows: eventRows,
    });
    const relations = await adaptEventRelationRows({
      projectId: "project-1",
      rows: [
        {
          projectId: "project-1",
          causeEventId: "cause",
          effectEventId: "effect",
          causeVersion: 1,
          causeUpdatedAt: "2026-08-10T01:02:03.000Z",
          effectVersion: 1,
          effectUpdatedAt: "2026-08-10T01:02:03.000Z",
        },
      ],
    });

    expect(events.nodes.map((node) => node.shape)).toEqual(["point", "point"]);
    expect(relations.constraints[0]?.relation).toBe("before-or-equal");
    const graph = await buildTemporalConstraintGraph({
      timeline: { kind: "primary" },
      nodes: events.nodes,
      constraints: [...events.constraints, ...relations.constraints],
      calendar,
      coverage: {
        status: "complete",
        documentRefs: [],
        omittedDocumentRefs: [],
      },
      diagnostics: [...events.diagnostics, ...relations.diagnostics],
    });
    if (!graph.ok) throw new Error(JSON.stringify(graph.diagnostics));
    expect(graph.graph.constraints).toHaveLength(3);
  });
});
