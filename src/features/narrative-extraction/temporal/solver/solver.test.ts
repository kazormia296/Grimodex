import { describe, expect, it } from "vitest";
import type { TemporalConstraint } from "../constraints";
import type { TemporalConstraintGraph } from "../graph";
import type { TemporalNode } from "../nodes";
import { dayToEpochMinute, MINUTES_PER_DAY } from "../resolution";
import { resolveStoryRanks } from "./resolveStoryRanks";
import { solveTemporalGraph } from "./solveTemporalGraph";
import { calendarConstraintPass } from "./calendarConstraintPass";

const fingerprint = `sha256:${"b".repeat(64)}` as const;
const calendarDigest = `sha256:${"c".repeat(64)}` as const;

function node(
  id: TemporalNode["id"],
  shape: TemporalNode["shape"] = "point",
): TemporalNode {
  return {
    id,
    timeline: { kind: "primary" },
    subject: { kind: "event", eventId: id },
    shape,
    discoursePositions: [],
    fingerprint,
  };
}

function graph(
  nodes: readonly TemporalNode[],
  constraints: readonly TemporalConstraint[],
): TemporalConstraintGraph {
  return {
    schemaVersion: 1,
    graphVersion: "gdx-temporal-graph/1",
    timeline: { kind: "primary" },
    nodes,
    constraints,
    calendar: null,
    coverage: {
      status: "complete",
      documentRefs: [],
      omittedDocumentRefs: [],
    },
    diagnostics: [],
    digest: fingerprint,
  };
}

function absoluteDay(
  id: string,
  nodeId: TemporalNode["id"],
  day: number,
): TemporalConstraint {
  return {
    id,
    kind: "absolute-window",
    nodeId,
    endpoint: "point",
    literal: {
      kind: "absolute",
      calendarRef: "CAL001",
      year: 1,
      day,
      granularity: "day",
      precision: "exact",
    },
    resolved: {
      calendarRef: "CAL001",
      calendarDigest,
      startDay: day,
      endDay: day,
      startMinute: null,
      endMinute: null,
      granularity: "day",
      precision: "exact",
    },
    authority: "user-metadata",
    strictness: "hard",
    sourceIds: ["obs:1"],
    fingerprint,
  };
}

describe("solveTemporalGraph", () => {
  it("resolves an absolute day onto an event node", () => {
    const result = solveTemporalGraph(
      graph([node("tn:a")], [absoluteDay("c1", "tn:a", 10)]),
    );
    const a = result.hardResolution.find((r) => r.nodeId === "tn:a");
    expect(a?.resolution).toBe("bounded");
    expect(a?.actualStart.earliest).toBe(dayToEpochMinute(10, 0));
    expect(a?.actualStart.latest).toBe(
      dayToEpochMinute(10, MINUTES_PER_DAY - 1),
    );
    expect(result.conflicts).toEqual([]);
  });

  it("propagates a relative day offset", () => {
    const constraints: TemporalConstraint[] = [
      absoluteDay("c1", "tn:a", 10),
      {
        id: "c2",
        kind: "relative-offset",
        left: { nodeId: "tn:b", endpoint: "point" },
        right: { nodeId: "tn:a", endpoint: "point" },
        offset: { min: 3, max: 3, unit: "day", arithmetic: "fixed" },
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:2"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(
      graph([node("tn:a"), node("tn:b")], constraints),
    );
    const b = result.hardResolution.find((r) => r.nodeId === "tn:b");
    expect(b?.actualStart.earliest).toBe(dayToEpochMinute(13, 0));
    expect(b?.actualStart.latest).toBe(
      dayToEpochMinute(13, MINUTES_PER_DAY - 1),
    );
  });

  it("propagates multi-hop offsets", () => {
    const constraints: TemporalConstraint[] = [
      absoluteDay("c1", "tn:a", 10),
      {
        id: "c2",
        kind: "relative-offset",
        left: { nodeId: "tn:b", endpoint: "point" },
        right: { nodeId: "tn:a", endpoint: "point" },
        offset: { min: 3, max: 3, unit: "day", arithmetic: "fixed" },
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:2"],
        fingerprint,
      },
      {
        id: "c3",
        kind: "relative-offset",
        left: { nodeId: "tn:c", endpoint: "point" },
        right: { nodeId: "tn:b", endpoint: "point" },
        offset: { min: 1, max: 1, unit: "day", arithmetic: "fixed" },
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:3"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(
      graph([node("tn:a"), node("tn:b"), node("tn:c")], constraints),
    );
    const c = result.hardResolution.find((r) => r.nodeId === "tn:c");
    expect(c?.actualStart.earliest).toBe(dayToEpochMinute(14, 0));
  });

  it("detects a negative cycle between absolute and relative constraints", () => {
    const constraints: TemporalConstraint[] = [
      absoluteDay("c1", "tn:a", 10),
      absoluteDay("c2", "tn:b", 12),
      {
        id: "c3",
        kind: "relative-offset",
        left: { nodeId: "tn:b", endpoint: "point" },
        right: { nodeId: "tn:a", endpoint: "point" },
        offset: { min: 3, max: 3, unit: "day", arithmetic: "fixed" },
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:3"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(
      graph([node("tn:a"), node("tn:b")], constraints),
    );
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]?.constraintIds.length).toBeGreaterThan(0);
  });

  it("keeps soft constraints out of hardResolution conflicts", () => {
    const constraints: TemporalConstraint[] = [
      absoluteDay("c1", "tn:a", 10),
      absoluteDay("c2", "tn:b", 11),
      {
        id: "c3",
        kind: "relative-offset",
        left: { nodeId: "tn:b", endpoint: "point" },
        right: { nodeId: "tn:a", endpoint: "point" },
        offset: { min: 5, max: 5, unit: "day", arithmetic: "fixed" },
        authority: "model-inferred",
        strictness: "soft",
        sourceIds: ["obs:3"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(
      graph([node("tn:a"), node("tn:b")], constraints),
    );
    expect(result.conflicts).toEqual([]);
    expect(
      result.hardResolution.every((r) => r.resolution !== "contradictory"),
    ).toBe(true);
  });

  it("does not invent week length when weekday names are absent", () => {
    const constraints: TemporalConstraint[] = [
      absoluteDay("c1", "tn:a", 10),
      {
        id: "c2",
        kind: "relative-offset",
        left: { nodeId: "tn:b", endpoint: "point" },
        right: { nodeId: "tn:a", endpoint: "point" },
        offset: { min: 1, max: 1, unit: "week", arithmetic: "fixed" },
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:2"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(
      graph([node("tn:a"), node("tn:b")], constraints),
    );
    const b = result.hardResolution.find((r) => r.nodeId === "tn:b");
    expect(b?.actualStart.earliest).toBeNull();
    expect(b?.actualStart.latest).toBeNull();
  });

  it("is independent of constraint input order", () => {
    const a = absoluteDay("c1", "tn:a", 10);
    const rel: TemporalConstraint = {
      id: "c2",
      kind: "relative-offset",
      left: { nodeId: "tn:b", endpoint: "point" },
      right: { nodeId: "tn:a", endpoint: "point" },
      offset: { min: 2, max: 2, unit: "day", arithmetic: "fixed" },
      authority: "explicit-story-text",
      strictness: "hard",
      sourceIds: ["obs:2"],
      fingerprint,
    };
    const nodes = [node("tn:a"), node("tn:b")];
    const forward = solveTemporalGraph(graph(nodes, [a, rel]));
    const reverse = solveTemporalGraph(graph(nodes, [rel, a]));
    expect(forward.hardResolution).toEqual(reverse.hardResolution);
  });

  it("marks symbolic constraints without inventing minutes", () => {
    const constraints: TemporalConstraint[] = [
      {
        id: "c1",
        kind: "symbolic",
        nodeId: "tn:a",
        relation: "same-night",
        anchorNodeId: null,
        label: "同じ夜",
        authority: "explicit-story-text",
        strictness: "hard",
        sourceIds: ["obs:1"],
        fingerprint,
      },
    ];
    const result = solveTemporalGraph(graph([node("tn:a")], constraints));
    expect(result.hardResolution[0]?.resolution).toBe("symbolic");
    expect(result.hardResolution[0]?.actualStart.earliest).toBeNull();
  });
});

describe("calendarConstraintPass", () => {
  it("refuses silent month clip", () => {
    const result = calendarConstraintPass(
      [
        {
          id: "c-month",
          kind: "relative-offset",
          left: { nodeId: "tn:b", endpoint: "point" },
          right: { nodeId: "tn:a", endpoint: "point" },
          offset: { min: 1, max: 1, unit: "month", arithmetic: "calendar" },
          authority: "explicit-story-text",
          strictness: "hard",
          sourceIds: ["obs:1"],
          fingerprint,
        },
      ],
      null,
      new Map(),
    );
    expect(
      result.diagnostics.some(
        (d) => d.code === "calendar-arithmetic-invalid-target",
      ),
    ).toBe(true);
  });
});

describe("resolveStoryRanks", () => {
  it("keeps incomparable nodes from inventing total order", () => {
    const ranks = resolveStoryRanks(
      ["tn:a", "tn:b", "tn:c"],
      [
        { earlier: "tn:a", later: "tn:b" },
        { earlier: "tn:a", later: "tn:c" },
      ],
    );
    expect(ranks.compare("tn:b", "tn:c")).toEqual({ kind: "incomparable" });
    expect(ranks.compare("tn:a", "tn:b")).toEqual({ kind: "before" });
  });

  it("preserves same-time groups", () => {
    const ranks = resolveStoryRanks(
      ["tn:a", "tn:b"],
      [{ earlier: "tn:a", later: "tn:b", equal: true }],
    );
    expect(ranks.compare("tn:a", "tn:b")).toEqual({ kind: "equal" });
    expect(ranks.equalTimeGroups.get("tn:a")).toBe(
      ranks.equalTimeGroups.get("tn:b"),
    );
  });
});
