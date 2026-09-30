import { describe, expect, it } from "vitest";
import {
  buildExtractionCalendarSnapshot,
  type ExtractionCalendarSnapshot,
} from "@/features/chronicle/calendar/extractionCalendarSnapshot";
import type { TemporalConstraint } from "./constraints";
import {
  buildTemporalConstraintGraph,
  type TemporalConstraintGraphBuildInput,
  verifyTemporalConstraintGraph,
} from "./graph";
import type { TemporalNode } from "./nodes";

const fingerprintA = `sha256:${"a".repeat(64)}` as const;
const fingerprintB = `sha256:${"b".repeat(64)}` as const;
const calendarDigest =
  "sha256:677862e6c4ae8b846ce3ea73fb97e4fd259f74bfb686814c8a15e9cbe0275a16" as const;

const calendar: ExtractionCalendarSnapshot = {
  schemaVersion: 1,
  calendarRef: "CAL001",
  version: 2,
  digest: calendarDigest,
  startYear: 100,
  daysPerYear: 360,
  months: [],
  seasons: [],
  eras: [],
  weekdayNames: [],
  weekdayStartIndex: 0,
  leapRule: { kind: "none" },
  reform: null,
  timezone: null,
  lunarTzMinutes: 480,
};

const nodes: readonly TemporalNode[] = [
  {
    id: "tn:b",
    timeline: { kind: "primary" },
    subject: { kind: "event", eventId: "event-b" },
    shape: "point",
    discoursePositions: [
      { documentRef: "D000002", documentOrderIndex: 1, canonicalOffset: 3 },
    ],
    fingerprint: fingerprintB,
  },
  {
    id: "tn:a",
    timeline: { kind: "primary" },
    subject: { kind: "scene", documentRef: "D000001" },
    shape: "interval",
    discoursePositions: [
      { documentRef: "D000001", documentOrderIndex: 0, canonicalOffset: 0 },
    ],
    fingerprint: fingerprintA,
  },
];

const constraints: readonly TemporalConstraint[] = [
  {
    id: "constraint-b",
    kind: "relative-offset",
    left: { nodeId: "tn:b", endpoint: "point" },
    right: { nodeId: "tn:a", endpoint: "end" },
    offset: { min: 1, max: 1, unit: "day", arithmetic: "fixed" },
    authority: "explicit-story-text",
    strictness: "hard",
    sourceIds: ["observation-b", "observation-a"],
    fingerprint: fingerprintB,
  },
  {
    id: "constraint-a",
    kind: "absolute-window",
    nodeId: "tn:a",
    endpoint: "start",
    literal: null,
    resolved: {
      calendarRef: "CAL001",
      calendarDigest,
      startDay: 10,
      endDay: 10,
      startMinute: null,
      endMinute: null,
      granularity: "day",
      precision: "exact",
    },
    authority: "user-metadata",
    strictness: "hard",
    sourceIds: [],
    fingerprint: fingerprintA,
  },
];

function input(
  overrides: Partial<TemporalConstraintGraphBuildInput> = {},
): TemporalConstraintGraphBuildInput {
  return {
    timeline: { kind: "primary" },
    nodes,
    constraints,
    calendar,
    coverage: {
      status: "complete",
      documentRefs: ["D000002", "D000001"],
      omittedDocumentRefs: [],
    },
    diagnostics: [],
    ...overrides,
  };
}

describe("buildTemporalConstraintGraph", () => {
  it("canonicalizes unordered graph inputs before sealing the digest", async () => {
    const first = await buildTemporalConstraintGraph(input());
    const reordered = await buildTemporalConstraintGraph(
      input({
        nodes: [...nodes].reverse(),
        constraints: [...constraints].reverse(),
        coverage: {
          status: "complete",
          documentRefs: ["D000001", "D000002"],
          omittedDocumentRefs: [],
        },
      }),
    );

    expect(first.ok && reordered.ok).toBe(true);
    if (!first.ok || !reordered.ok) return;
    expect(first.graph.digest).toBe(reordered.graph.digest);
    expect(first.graph.nodes.map((node) => node.id)).toEqual(["tn:a", "tn:b"]);
    expect(first.graph.constraints.map((constraint) => constraint.id)).toEqual([
      "constraint-a",
      "constraint-b",
    ]);
    expect(first.graph.constraints[1]?.sourceIds).toEqual([
      "observation-a",
      "observation-b",
    ]);
  });

  it("copies caller data before await and recursively freezes the graph", async () => {
    const mutableNodes = nodes.map((node) => ({
      ...node,
      discoursePositions: node.discoursePositions.map((position) => ({
        ...position,
      })),
    })) as TemporalNode[];
    const pending = buildTemporalConstraintGraph(
      input({ nodes: mutableNodes }),
    );
    (
      mutableNodes[0]!.discoursePositions as Array<{
        documentRef: string;
        documentOrderIndex: number;
        canonicalOffset: number;
      }>
    )[0]!.canonicalOffset = 999;
    const result = await pending;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.graph.nodes.find((node) => node.id === "tn:b")
        ?.discoursePositions[0],
    ).toEqual(expect.objectContaining({ canonicalOffset: 3 }));
    expect(Object.isFrozen(result.graph)).toBe(true);
    expect(Object.isFrozen(result.graph.nodes)).toBe(true);
    expect(Object.isFrozen(result.graph.nodes[0]?.subject)).toBe(true);
  });

  it("rejects duplicate ids, dangling refs, and graph/node timeline mismatches", async () => {
    const result = await buildTemporalConstraintGraph(
      input({
        nodes: [
          nodes[0]!,
          { ...nodes[0]!, timeline: { kind: "alternate", key: "route-a" } },
        ],
        constraints: [
          {
            ...constraints[0]!,
            left: { nodeId: "tn:missing", endpoint: "point" },
          } as TemporalConstraint,
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "TEMPORAL_GRAPH_DUPLICATE_NODE_ID",
        "TEMPORAL_GRAPH_TIMELINE_MISMATCH",
        "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
      ]),
    );
  });

  it("accepts relative-only graphs without a calendar", async () => {
    const result = await buildTemporalConstraintGraph(
      input({ calendar: null, constraints: [constraints[0]!] }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects canonical windows sealed against another calendar", async () => {
    const result = await buildTemporalConstraintGraph(
      input({
        constraints: [
          {
            ...constraints[1]!,
            resolved: {
              ...(
                constraints[1] as Extract<
                  TemporalConstraint,
                  { kind: "absolute-window" }
                >
              ).resolved!,
              calendarDigest: `sha256:${"d".repeat(64)}`,
            },
          } as TemporalConstraint,
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_GRAPH_CALENDAR_DIGEST_MISMATCH",
        }),
      ]),
    );
  });

  it("rejects a forged Calendar Snapshot even when constraints repeat its claimed digest", async () => {
    const forgedCalendar = {
      ...calendar,
      daysPerYear: 361,
    } as ExtractionCalendarSnapshot;
    const result = await buildTemporalConstraintGraph(
      input({ calendar: forgedCalendar }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMPORAL_GRAPH_INVALID_CALENDAR" }),
      ]),
    );
  });

  it("re-verifies a sealed graph and rejects content changed under its old digest", async () => {
    const built = await buildTemporalConstraintGraph(input());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const verified = await verifyTemporalConstraintGraph(built.graph);
    const tampered = structuredClone(built.graph) as unknown as {
      constraints: Array<TemporalConstraint>;
    };
    const relative = tampered.constraints.find(
      (constraint) => constraint.kind === "relative-offset",
    ) as Extract<TemporalConstraint, { kind: "relative-offset" }>;
    (
      relative.offset as {
        min: number;
        max: number;
        unit: "day";
        arithmetic: "fixed";
      }
    ).min = 0;
    const rejected = await verifyTemporalConstraintGraph(tampered);

    expect(verified.ok).toBe(true);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMPORAL_GRAPH_DIGEST_MISMATCH" }),
      ]),
    );
  });

  it("rejects a sealed graph tampered into a reversed same-day minute window", async () => {
    const resolved = (
      constraints[1] as Extract<TemporalConstraint, { kind: "absolute-window" }>
    ).resolved!;
    const built = await buildTemporalConstraintGraph(
      input({
        constraints: [
          constraints[0]!,
          {
            ...constraints[1]!,
            resolved: {
              ...resolved,
              startMinute: 600,
              endMinute: 900,
              granularity: "time",
            },
          } as TemporalConstraint,
        ],
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const tampered = structuredClone(built.graph) as unknown as {
      constraints: Array<TemporalConstraint>;
    };
    const absolute = tampered.constraints.find(
      (constraint) => constraint.kind === "absolute-window",
    ) as Extract<TemporalConstraint, { kind: "absolute-window" }>;
    (
      absolute.resolved as {
        startMinute: number;
        endMinute: number;
      }
    ).startMinute = 1_000;

    const rejected = await verifyTemporalConstraintGraph(tampered);

    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_CONSTRAINT_INVALID_RANGE",
        }),
      ]),
    );
  });

  it.each([
    [
      "overlapping partial sets",
      {
        status: "partial",
        documentRefs: ["D000001"],
        omittedDocumentRefs: ["D000001"],
      },
    ],
    [
      "overlapping complete sets",
      {
        status: "complete",
        documentRefs: ["D000001"],
        omittedDocumentRefs: ["D000001"],
      },
    ],
    [
      "duplicate included refs",
      {
        status: "complete",
        documentRefs: ["D000001", "D000001"],
        omittedDocumentRefs: [],
      },
    ],
    [
      "duplicate omitted refs",
      {
        status: "partial",
        documentRefs: ["D000001"],
        omittedDocumentRefs: ["D000002", "D000002"],
      },
    ],
    [
      "partial status without omissions",
      {
        status: "partial",
        documentRefs: ["D000001"],
        omittedDocumentRefs: [],
      },
    ],
  ] as const)("rejects coverage with %s", async (_name, coverage) => {
    const result = await buildTemporalConstraintGraph(input({ coverage }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMPORAL_GRAPH_INVALID_COVERAGE" }),
      ]),
    );
  });

  it("rejects a discourse position outside the included coverage set", async () => {
    const invalidNodes: readonly TemporalNode[] = [
      {
        ...nodes[0]!,
        discoursePositions: [
          {
            documentRef: "D000003",
            documentOrderIndex: 1,
            canonicalOffset: 3,
          },
        ],
      },
      nodes[1]!,
    ];
    const result = await buildTemporalConstraintGraph(
      input({ nodes: invalidNodes }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_GRAPH_COVERAGE_MISMATCH",
        }),
      ]),
    );
  });

  it("allows an omitted Scene subject as a Domain virtual node when its discourse evidence is included", async () => {
    const result = await buildTemporalConstraintGraph(
      input({
        nodes: [
          nodes[0]!,
          {
            ...nodes[1]!,
            subject: { kind: "scene", documentRef: "D000003" },
          },
        ],
        coverage: {
          status: "partial",
          documentRefs: ["D000001", "D000002"],
          omittedDocumentRefs: ["D000003"],
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("rejects node document refs declared as omitted from partial coverage", async () => {
    const result = await buildTemporalConstraintGraph(
      input({
        coverage: {
          status: "partial",
          documentRefs: ["D000001"],
          omittedDocumentRefs: ["D000002"],
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_GRAPH_COVERAGE_MISMATCH",
          path: "nodes[0].discoursePositions[0].documentRef",
        }),
      ]),
    );
  });

  it.each([
    ["eraRef", "E999999"],
    ["monthRef", "M999999"],
    ["seasonRef", "S999999"],
  ] as const)(
    "rejects an unknown calendar catalog %s",
    async (catalogKey, opaqueRef) => {
      const absolute = constraints[1] as Extract<
        TemporalConstraint,
        { kind: "absolute-window" }
      >;
      const result = await buildTemporalConstraintGraph(
        input({
          constraints: [
            constraints[0]!,
            {
              ...absolute,
              literal: {
                kind: "absolute",
                calendarRef: calendar.calendarRef,
                [catalogKey]: opaqueRef,
                granularity: "month",
                precision: "exact",
              },
            } as TemporalConstraint,
          ],
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "TEMPORAL_GRAPH_UNKNOWN_CALENDAR_CATALOG_REF",
            path: `constraints[1].literal.${catalogKey}`,
          }),
        ]),
      );
    },
  );

  it("accepts opaque Calendar catalog refs present in the verified snapshot", async () => {
    const builtCalendar = await buildExtractionCalendarSnapshot({
      version: 3,
      startYear: 100,
      daysPerYear: 360,
      months: JSON.stringify([{ name: "First", days: 360 }]),
      seasonBoundaries: JSON.stringify([
        { name: "First season", startDayOfYear: 0 },
      ]),
      eras: JSON.stringify([{ name: "First era", startYear: 100 }]),
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: JSON.stringify({ kind: "none" }),
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 0,
    });
    expect(builtCalendar.ok).toBe(true);
    if (!builtCalendar.ok) return;
    const absolute = constraints[1] as Extract<
      TemporalConstraint,
      { kind: "absolute-window" }
    >;
    const result = await buildTemporalConstraintGraph(
      input({
        calendar: builtCalendar.snapshot,
        constraints: [
          constraints[0]!,
          {
            ...absolute,
            literal: {
              kind: "absolute",
              calendarRef: builtCalendar.snapshot.calendarRef,
              eraRef: builtCalendar.snapshot.eras[0]!.ref,
              monthRef: builtCalendar.snapshot.months[0]!.ref,
              seasonRef: builtCalendar.snapshot.seasons[0]!.ref,
              granularity: "month",
              precision: "exact",
            },
            resolved: {
              ...absolute.resolved!,
              calendarDigest: builtCalendar.snapshot.digest,
            },
          } as TemporalConstraint,
        ],
      }),
    );

    expect(result.ok).toBe(true);
  });

  it.each([
    ["nodes", { nodes: null }, "TEMPORAL_GRAPH_INVALID_NODES"],
    [
      "constraints",
      { constraints: { bad: true } },
      "TEMPORAL_GRAPH_INVALID_CONSTRAINTS",
    ],
    [
      "diagnostics",
      { diagnostics: "broken" },
      "TEMPORAL_GRAPH_INVALID_DIAGNOSTICS",
    ],
    ["coverage", { coverage: null }, "TEMPORAL_GRAPH_INVALID_COVERAGE"],
  ] as const)(
    "returns typed diagnostics instead of throwing for malformed %s",
    async (_name, malformed, code) => {
      const result = await buildTemporalConstraintGraph({
        ...input(),
        ...malformed,
      } as unknown as TemporalConstraintGraphBuildInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    },
  );

  it("returns a typed diagnostic for a malformed top-level envelope", async () => {
    const result = await buildTemporalConstraintGraph(
      null as unknown as TemporalConstraintGraphBuildInput,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMPORAL_GRAPH_INVALID_INPUT" }),
      ]),
    );
  });

  it("projects only declared IR fields and drops untrusted extras", async () => {
    const result = await buildTemporalConstraintGraph(
      input({
        nodes: [
          {
            ...nodes[0]!,
            actualDatabaseId: "event-secret",
          } as unknown as TemporalNode,
          nodes[1]!,
        ],
        constraints: [
          {
            ...constraints[0]!,
            hiddenPrompt: "do not seal me",
          } as unknown as TemporalConstraint,
          constraints[1]!,
        ],
        diagnostics: [
          {
            code: "TEMPORAL_NOTE",
            message: "Visible diagnostic",
            secretMetadata: "diagnostic-secret",
          } as TemporalConstraintGraphBuildInput["diagnostics"][number],
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.graph)).not.toContain("event-secret");
    expect(JSON.stringify(result.graph)).not.toContain("do not seal me");
    expect(JSON.stringify(result.graph)).not.toContain("diagnostic-secret");
  });

  it.each([
    ["node", { nodes: [null] }, "TEMPORAL_GRAPH_INVALID_NODE"],
    [
      "constraint",
      { constraints: [null] },
      "TEMPORAL_GRAPH_INVALID_CONSTRAINT",
    ],
  ] as const)(
    "returns typed diagnostics for a malformed nested %s",
    async (_name, malformed, code) => {
      const result = await buildTemporalConstraintGraph({
        ...input(),
        ...malformed,
      } as unknown as TemporalConstraintGraphBuildInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code })]),
      );
    },
  );

  it("returns typed diagnostics for a malformed absolute resolution", async () => {
    const malformed = {
      ...constraints[1]!,
      resolved: undefined,
    } as unknown as TemporalConstraint;
    const result = await buildTemporalConstraintGraph(
      input({ constraints: [malformed] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_CONSTRAINT_INVALID_CALENDAR_RESOLUTION",
        }),
      ]),
    );
  });
});
