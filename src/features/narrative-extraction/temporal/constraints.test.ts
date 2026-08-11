import { describe, expect, it } from "vitest";
import type { TemporalConstraint } from "./constraints";
import { validateTemporalConstraint } from "./constraints";
import type { TemporalNode } from "./nodes";

const fingerprint = `sha256:${"a".repeat(64)}` as const;

const nodes: readonly TemporalNode[] = [
  {
    id: "tn:left",
    timeline: { kind: "primary" },
    subject: { kind: "event", eventId: "event-left" },
    shape: "point",
    discoursePositions: [],
    fingerprint,
  },
  {
    id: "tn:right",
    timeline: { kind: "primary" },
    subject: { kind: "event", eventId: "event-right" },
    shape: "interval",
    discoursePositions: [],
    fingerprint,
  },
];

function relative(
  overrides: Partial<
    Extract<TemporalConstraint, { kind: "relative-offset" }>
  > = {},
): Extract<TemporalConstraint, { kind: "relative-offset" }> {
  return {
    id: "constraint-relative",
    kind: "relative-offset",
    left: { nodeId: "tn:left", endpoint: "point" },
    right: { nodeId: "tn:right", endpoint: "start" },
    offset: { min: 3, max: 3, unit: "day", arithmetic: "fixed" },
    authority: "explicit-story-text",
    strictness: "hard",
    sourceIds: ["observation-1"],
    fingerprint,
    ...overrides,
  };
}

describe("validateTemporalConstraint", () => {
  it("accepts a canonical-domain absolute window without a reconstructed literal", () => {
    const constraint: TemporalConstraint = {
      id: "constraint-absolute",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: null,
      resolved: {
        calendarRef: "CAL001",
        calendarDigest: `sha256:${"b".repeat(64)}`,
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
      fingerprint,
    };

    expect(validateTemporalConstraint(constraint, nodes)).toEqual([]);
  });

  it("requires every constraint kind to carry strictness and a fingerprint", () => {
    const invalid = {
      ...relative(),
      strictness: undefined,
      fingerprint: "not-a-digest",
    } as unknown as TemporalConstraint;

    expect(
      validateTemporalConstraint(invalid, nodes).map((item) => item.code),
    ).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_INVALID_STRICTNESS",
        "TEMPORAL_CONSTRAINT_INVALID_FINGERPRINT",
      ]),
    );
  });

  it("rejects dangling endpoints, incompatible point endpoints, and invalid ranges", () => {
    const diagnostics = validateTemporalConstraint(
      relative({
        left: { nodeId: "tn:missing", endpoint: "point" },
        right: { nodeId: "tn:left", endpoint: "start" },
        offset: {
          min: 4,
          max: 3,
          unit: "day",
          arithmetic: "fixed",
        },
      }),
      nodes,
    );

    expect(diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_UNKNOWN_NODE",
        "TEMPORAL_CONSTRAINT_INVALID_ENDPOINT",
        "TEMPORAL_CONSTRAINT_INVALID_RANGE",
      ]),
    );
  });

  it("rejects an unknown endpoint enum even when the node shape is unknown", () => {
    const unknownShapeNode: TemporalNode = {
      id: "tn:unknown-shape",
      timeline: { kind: "primary" },
      subject: { kind: "event", eventId: "event-unknown-shape" },
      shape: "unknown",
      discoursePositions: [],
      fingerprint,
    };
    const malformed = relative({
      left: {
        nodeId: unknownShapeNode.id,
        endpoint: "middle",
      } as unknown as Extract<
        TemporalConstraint,
        { kind: "relative-offset" }
      >["left"],
    });

    expect(
      validateTemporalConstraint(malformed, [...nodes, unknownShapeNode]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_CONSTRAINT_INVALID_ENDPOINT",
          path: "left.endpoint",
        }),
      ]),
    );
  });

  it("preserves signed relative ranges for left-minus-right constraints", () => {
    expect(
      validateTemporalConstraint(
        relative({
          offset: {
            min: -3,
            max: -1,
            unit: "day",
            arithmetic: "fixed",
          },
        }),
        nodes,
      ),
    ).toEqual([]);
  });

  it("returns diagnostics instead of throwing for malformed node entries", () => {
    expect(
      validateTemporalConstraint(relative(), [
        null,
      ] as unknown as readonly TemporalNode[]).map((item) => item.code),
    ).toEqual(expect.arrayContaining(["TEMPORAL_CONSTRAINT_UNKNOWN_NODE"]));
  });

  it("returns diagnostics for a malformed canonical resolution", () => {
    const malformed = {
      id: "constraint-malformed-resolution",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: null,
      resolved: undefined,
      authority: "user-metadata",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    } as unknown as TemporalConstraint;

    expect(
      validateTemporalConstraint(malformed, nodes).map((item) => item.code),
    ).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_INVALID_CALENDAR_RESOLUTION",
      ]),
    );
  });

  it("rejects a reversed minute window on the same canonical day", () => {
    const invalid: TemporalConstraint = {
      id: "constraint-reversed-minute-window",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: null,
      resolved: {
        calendarRef: "CAL001",
        calendarDigest: `sha256:${"b".repeat(64)}`,
        startDay: 10,
        endDay: 10,
        startMinute: 900,
        endMinute: 600,
        granularity: "time",
        precision: "exact",
      },
      authority: "user-metadata",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    };

    expect(validateTemporalConstraint(invalid, nodes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "TEMPORAL_CONSTRAINT_INVALID_RANGE",
          path: "resolved",
        }),
      ]),
    );
  });

  it("allows the end minute to be earlier when the window crosses days", () => {
    const valid: TemporalConstraint = {
      id: "constraint-cross-day-minute-window",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: null,
      resolved: {
        calendarRef: "CAL001",
        calendarDigest: `sha256:${"b".repeat(64)}`,
        startDay: 10,
        endDay: 11,
        startMinute: 900,
        endMinute: 600,
        granularity: "time",
        precision: "exact",
      },
      authority: "user-metadata",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    };

    expect(validateTemporalConstraint(valid, nodes)).toEqual([]);
  });

  it("rejects an absolute window with neither literal nor canonical resolution", () => {
    const invalid: TemporalConstraint = {
      id: "constraint-empty-absolute",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: null,
      resolved: null,
      authority: "user-metadata",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    };

    expect(validateTemporalConstraint(invalid, nodes)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TEMPORAL_CONSTRAINT_EMPTY_ABSOLUTE" }),
      ]),
    );
  });

  it("allows interval relations between point-shaped domain nodes", () => {
    const relation: TemporalConstraint = {
      id: "constraint-relation",
      kind: "interval-relation",
      leftNodeId: "tn:left",
      relation: "before-or-equal",
      rightNodeId: "tn:left",
      authority: "existing-domain-relation",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    };

    expect(validateTemporalConstraint(relation, nodes)).toEqual([]);
  });

  it("fails closed for unknown enum members and malformed absolute literals", () => {
    const malformed = {
      id: "constraint-malformed",
      kind: "absolute-window",
      nodeId: "tn:left",
      endpoint: "point",
      literal: {
        kind: "absolute",
        calendarRef: "   ",
        day: 0,
        hour: 24,
        minute: 60,
        granularity: "century",
        precision: "certain",
      },
      resolved: null,
      authority: "oracle",
      strictness: "hard",
      sourceIds: [],
      fingerprint,
    } as unknown as TemporalConstraint;

    expect(
      validateTemporalConstraint(malformed, nodes).map((item) => item.code),
    ).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_INVALID_AUTHORITY",
        "TEMPORAL_CONSTRAINT_INVALID_LITERAL",
      ]),
    );
  });

  it("rejects unknown relation, unit, arithmetic, and symbolic members", () => {
    const malformedRelative = {
      ...relative(),
      offset: {
        min: 1,
        max: 1,
        unit: "fortnight",
        arithmetic: "guess",
      },
    } as unknown as TemporalConstraint;
    const malformedSymbolic = {
      id: "constraint-symbolic",
      kind: "symbolic",
      nodeId: "tn:left",
      relation: "eventually",
      anchorNodeId: null,
      label: "   ",
      authority: "model-inferred",
      strictness: "soft",
      sourceIds: [],
      fingerprint,
    } as unknown as TemporalConstraint;

    expect(
      validateTemporalConstraint(malformedRelative, nodes).map(
        (item) => item.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_INVALID_UNIT",
        "TEMPORAL_CONSTRAINT_INVALID_ARITHMETIC",
      ]),
    );
    expect(
      validateTemporalConstraint(malformedSymbolic, nodes).map(
        (item) => item.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "TEMPORAL_CONSTRAINT_INVALID_RELATION",
        "TEMPORAL_CONSTRAINT_INVALID_LABEL",
      ]),
    );
  });
});
