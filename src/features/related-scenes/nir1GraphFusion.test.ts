import { describe, expect, it } from "vitest";
import type {
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphPathAttachment,
  RelatedScenesGraphPathEdge,
} from "@/../electron/shared/relatedScenesSearchWire";
import type { RelatedScene } from "./selectRelatedScenes";
import type {
  Nir1AdmittedScene,
  Nir1RelatedScenesResult,
} from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesGraphPayload } from "./nir1RelatedScenesFetchTypes";
import {
  fuseNir1RelatedScenesGraph,
  type Nir1GraphFusionInput,
} from "./nir1GraphFusion";

const raw = (sceneId: string): RelatedScene => ({
  sceneId,
  sceneTitle: `Raw ${sceneId}`,
  chunkText: `Raw excerpt ${sceneId}`,
  score: 0.9,
});
const admitted = (sceneId: string): Nir1AdmittedScene => ({
  sceneId,
  sceneTitle: `IR ${sceneId}`,
  irCosine: 0.9,
  interpretation: {
    summary: "s",
    actuality: "a",
    attribution: "b",
    narrativeFrame: "c",
  },
  validatedEvidence: { excerpt: "e", navigationIdentity: `nav-${sceneId}` },
  review: "human-approved",
  freshness: "fresh",
});
const rawResult = (
  ids: string[],
  ir: "empty" | "unavailable" = "empty",
): Nir1RelatedScenesResult => ({
  kind: "raw",
  scenes: ids.map(raw),
  ir:
    ir === "empty"
      ? { status: "empty" }
      : { status: "unavailable", reason: "timeout" },
});
const fused = (ids: string[], irOnly?: string): Nir1RelatedScenesResult => ({
  kind: "fused",
  scenes: [
    ...ids.map((id, at) => ({
      kind: "raw" as const,
      sceneId: id,
      sceneTitle: `Raw ${id}`,
      rank1: at + 1,
      raw: raw(id),
    })),
    ...(irOnly
      ? [
          {
            kind: "ir" as const,
            sceneId: irOnly,
            sceneTitle: `IR ${irOnly}`,
            rank1: ids.length + 1,
            ir: admitted(irOnly),
          },
        ]
      : []),
  ],
  ir: { status: "available" },
});
const edge = (
  from: string,
  to: string,
  quote = `${from} and ${to}`,
): RelatedScenesGraphPathEdge => ({
  relationType: "knows",
  directionality: "directed",
  from: { entityId: from, label: `Label ${from}` },
  to: { entityId: to, label: `Label ${to}` },
  evidence: [{ evidenceId: `ev-${from}-${to}`, quote }],
});
const attachment = (sceneId: string): RelatedScenesGraphPathAttachment => ({
  sceneId,
  hop: 1,
  edges: [edge("seed", `pin-${sceneId}`)],
});
const graphOnly = (
  overrides: Partial<RelatedScenesGraphOnlyRow> = {},
): RelatedScenesGraphOnlyRow => ({
  sceneId: "g",
  sceneTitle: "Graph scene",
  excerpt: "The first line.",
  canonicalRange: { start: 0, end: 15 },
  navigationIdentity: "nav-graph",
  path: { hop: 1, pinEntityId: "pin-g", edges: [edge("seed", "pin-g")] },
  ...overrides,
});
const payload = (
  overrides: Partial<Nir1RelatedScenesGraphPayload> = {},
): Nir1RelatedScenesGraphPayload => ({
  queryBinding: "qb",
  pathAttachments: [],
  graphOnly: null,
  ...overrides,
});
const input = (
  result: Nir1RelatedScenesResult,
  graph: Nir1RelatedScenesGraphPayload | undefined,
  overrides: Partial<Nir1GraphFusionInput> = {},
): Nir1GraphFusionInput => ({
  result,
  queryBinding: "qb",
  querySceneId: "current",
  graphOutcome: "graph-ready",
  graph,
  ...overrides,
});
const ids = (rows: readonly { sceneId: string }[]) =>
  rows.map((r) => r.sceneId);

describe("fuseNir1RelatedScenesGraph", () => {
  it("attaches each path to its displayed scene without changing membership, order, rank or excerpt", () => {
    const result = fused(["a", "b", "c"]);
    const fusion = fuseNir1RelatedScenesGraph(
      input(
        result,
        payload({ pathAttachments: [attachment("c"), attachment("a")] }),
      ),
    );
    expect(ids(fusion.rows)).toEqual(["a", "b", "c"]);
    expect(fusion.rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(
      fusion.rows.map((row) => (row.kind === "base" ? row.raw : null)),
    ).toEqual(
      result.kind === "fused"
        ? result.scenes.map((scene) => (scene.kind !== "ir" ? scene.raw : null))
        : [],
    );
    expect(
      fusion.rows.map((row) =>
        row.kind === "base" ? (row.path?.sceneId ?? null) : null,
      ),
    ).toEqual(["a", null, "c"]);
    expect(fusion.dropped).toEqual({ attachments: 0, graphOnly: 0 });
  });

  it("appends the Graph-only row last with rank n+1 when IR does not use the slot and Raw has fewer than 8", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(fused(["a", "b"]), payload({ graphOnly: graphOnly() })),
    );
    expect(ids(fusion.rows)).toEqual(["a", "b", "g"]);
    const last = fusion.rows[2];
    expect(last.kind).toBe("graph-only");
    expect(last.rank).toBe(3);
  });

  it("never appends when an ir row exists, or when Raw has 8", () => {
    const withIr = fuseNir1RelatedScenesGraph(
      input(fused(["a"], "ir"), payload({ graphOnly: graphOnly() })),
    );
    expect(ids(withIr.rows)).toEqual(["a", "ir"]);
    expect(withIr.dropped.graphOnly).toBe(1);
    const eight = ["1", "2", "3", "4", "5", "6", "7", "8"];
    for (const result of [fused(eight), rawResult(eight)]) {
      const full = fuseNir1RelatedScenesGraph(
        input(result, payload({ graphOnly: graphOnly() })),
      );
      expect(ids(full.rows)).toEqual(eight);
      expect(full.dropped.graphOnly).toBe(1);
    }
  });

  it("graphOnly null gives exactly the R/R+IR rows", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(fused(["a", "b"]), payload()),
    );
    expect(ids(fusion.rows)).toEqual(["a", "b"]);
    expect(fusion.rows.every((row) => row.kind === "base")).toBe(true);
  });

  it("a non-ready outcome gives exactly the R/R+IR rows", () => {
    for (const graphOutcome of [
      "graph-late",
      "graph-unavailable:restart-required",
      "graph-unavailable:not-activated",
      undefined,
    ] as const) {
      const fusion = fuseNir1RelatedScenesGraph(
        input(
          fused(["a"]),
          payload({
            pathAttachments: [attachment("a")],
            graphOnly: graphOnly(),
          }),
          { graphOutcome },
        ),
      );
      expect(ids(fusion.rows)).toEqual(["a"]);
      expect(fusion.rows[0].kind === "base" && fusion.rows[0].path).toBeNull();
      expect(fusion.dropped).toEqual({ attachments: 0, graphOnly: 0 });
    }
    const noGraph = fuseNir1RelatedScenesGraph(input(fused(["a"]), undefined));
    expect(ids(noGraph.rows)).toEqual(["a"]);
  });

  it("an attachment for an undisplayed scene or a duplicate drops every attachment and keeps the rows", () => {
    for (const pathAttachments of [
      [attachment("a"), attachment("zz")],
      [attachment("a"), attachment("a")],
      [{ ...attachment("a"), edges: [] }],
    ]) {
      const fusion = fuseNir1RelatedScenesGraph(
        input(
          fused(["a", "b"]),
          payload({ pathAttachments, graphOnly: graphOnly() }),
        ),
      );
      expect(ids(fusion.rows)).toEqual(["a", "b"]);
      expect(
        fusion.rows.every((row) => row.kind === "base" && row.path === null),
      ).toBe(true);
      // The Graph-only row is not shown either (P2-1).
      expect(fusion.dropped).toEqual({
        attachments: pathAttachments.length,
        graphOnly: 1,
      });
    }
  });

  it("a Graph payload of another query binding drops the whole Graph contribution", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(
        fused(["a"]),
        payload({
          queryBinding: "other",
          pathAttachments: [attachment("a")],
          graphOnly: graphOnly(),
        }),
      ),
    );
    expect(ids(fusion.rows)).toEqual(["a"]);
    expect(fusion.dropped).toEqual({ attachments: 1, graphOnly: 1 });
  });

  it("a Graph-only scene that is already displayed drops only that row", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(
        fused(["a", "b"]),
        payload({
          pathAttachments: [attachment("a")],
          graphOnly: graphOnly({ sceneId: "b" }),
        }),
      ),
    );
    expect(ids(fusion.rows)).toEqual(["a", "b"]);
    expect(fusion.rows[0].kind === "base" && fusion.rows[0].path?.sceneId).toBe(
      "a",
    );
    expect(fusion.dropped).toEqual({ attachments: 0, graphOnly: 1 });
  });

  it("a malformed Graph-only row drops only that row (P3-6)", () => {
    const bad: Partial<RelatedScenesGraphOnlyRow>[] = [
      { sceneId: "current" },
      { sceneId: "" },
      { excerpt: "" },
      { excerpt: "two\nlines", canonicalRange: { start: 0, end: 9 } },
      { excerpt: "carriage\rreturn", canonicalRange: { start: 0, end: 15 } },
      { navigationIdentity: "" },
      { canonicalRange: { start: 0, end: 14 } },
      { canonicalRange: { start: -1, end: 14 } },
      { canonicalRange: { start: 0.5, end: 15.5 } },
      { canonicalRange: { start: 15, end: 15 } },
      { path: { hop: 1, pinEntityId: "pin-g", edges: [] } },
      {
        path: {
          hop: 1,
          pinEntityId: "elsewhere",
          edges: [edge("seed", "pin-g")],
        },
      },
      { path: { hop: 1, pinEntityId: "", edges: [edge("seed", "pin-g")] } },
    ];
    for (const overrides of bad) {
      const fusion = fuseNir1RelatedScenesGraph(
        input(
          fused(["a"]),
          payload({
            pathAttachments: [attachment("a")],
            graphOnly: graphOnly(overrides),
          }),
        ),
      );
      expect(ids(fusion.rows)).toEqual(["a"]);
      expect(
        fusion.rows[0].kind === "base" && fusion.rows[0].path?.sceneId,
      ).toBe("a");
      expect(fusion.dropped).toEqual({ attachments: 0, graphOnly: 1 });
    }
    const pinAtStart = fuseNir1RelatedScenesGraph(
      input(
        fused(["a"]),
        payload({
          graphOnly: graphOnly({
            path: {
              hop: 1,
              pinEntityId: "seed",
              edges: [edge("seed", "pin-g")],
            },
          }),
        }),
      ),
    );
    expect(ids(pinAtStart.rows)).toEqual(["a", "g"]);
  });

  it("appends after a raw result whose IR was empty (C14)", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(rawResult(["a"]), payload({ graphOnly: graphOnly() })),
    );
    expect(ids(fusion.rows)).toEqual(["a", "g"]);
    expect(fusion.rows[0].rank).toBeUndefined();
    expect(fusion.rows[1].rank).toBe(2);
    const unavailable = fuseNir1RelatedScenesGraph(
      input(
        rawResult(["a"], "unavailable"),
        payload({ graphOnly: graphOnly() }),
      ),
    );
    expect(ids(unavailable.rows)).toEqual(["a", "g"]);
  });

  it("shows the Graph-only row when R and IR are both empty (P3-5)", () => {
    const fusion = fuseNir1RelatedScenesGraph(
      input(rawResult([]), payload({ graphOnly: graphOnly() })),
    );
    expect(ids(fusion.rows)).toEqual(["g"]);
    expect(fusion.rows[0].rank).toBe(1);
  });

  it("does not mutate or replace fetch.result", () => {
    const result = fused(["a", "b"]);
    const snapshot = structuredClone(result);
    const graph = payload({
      pathAttachments: [attachment("a")],
      graphOnly: graphOnly(),
    });
    const graphSnapshot = structuredClone(graph);
    const source = input(result, graph);
    fuseNir1RelatedScenesGraph(source);
    expect(source.result).toBe(result);
    expect(result).toEqual(snapshot);
    expect(graph).toEqual(graphSnapshot);
  });

  it("builds the G-01 shape [g01-question, g01-mira] with the excerpt and range copied exactly", () => {
    const excerpt = "ミラは問いの答えを知っていた。".repeat(6).slice(0, 78);
    expect(excerpt.length).toBe(78);
    const row = graphOnly({
      sceneId: "g01-mira",
      sceneTitle: "Mira",
      excerpt,
      canonicalRange: { start: 0, end: 78 },
      path: {
        hop: 1,
        pinEntityId: "mira",
        edges: [edge("question", "mira")],
      },
    });
    const fusion = fuseNir1RelatedScenesGraph(
      input(fused(["g01-question"]), payload({ graphOnly: row })),
    );
    expect(ids(fusion.rows)).toEqual(["g01-question", "g01-mira"]);
    const last = fusion.rows[1];
    expect(last.kind === "graph-only" && last.graphOnly).toBe(row);
    expect(last.kind === "graph-only" && last.graphOnly.excerpt).toBe(excerpt);
    expect(last.kind === "graph-only" && last.graphOnly.canonicalRange).toEqual(
      {
        start: 0,
        end: 78,
      },
    );
  });
});
