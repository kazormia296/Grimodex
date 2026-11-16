import { describe, expect, it } from "vitest";
import type {
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphPathAttachment,
  RelatedScenesGraphPathEdge,
} from "@/../electron/shared/relatedScenesSearchWire";
import type { Nir1RelatedScenesResult } from "@/features/related-scenes/nir1RelatedScenesResult";
import type {
  Nir1RelatedScenesFetchResult,
  Nir1RelatedScenesGraphPayload,
} from "@/features/related-scenes/nir1RelatedScenesFetchTypes";
import { graphEvidenceOf, rowTextsOf } from "./cp4-k64-probe";

// Run by `cp4-k64-probe-vitest.test.mjs` (vitest.probe.config.ts): the product's
// vitest config only includes `src`, and the product source never names the
// eval renderer (renderer-build.test.mjs D11 / T-2).
//
// CP-4 quality verdict v3 (§2.3, §2.0): the rows the probe reports are the
// product's fused display rows, not the raw result and not the Graph payload.

const edge = (from: string, to: string): RelatedScenesGraphPathEdge => ({
  relationType: "knows",
  directionality: "directed",
  from: { entityId: from, label: from },
  to: { entityId: to, label: to },
  evidence: [{ evidenceId: `ev-${from}-${to}`, quote: `quote ${from} ${to}` }],
});
const attachment = (sceneId: string): RelatedScenesGraphPathAttachment => ({
  sceneId,
  hop: 1,
  edges: [edge("seed", `pin-${sceneId}`)],
});
const graphOnly = (sceneId = "g"): RelatedScenesGraphOnlyRow => ({
  sceneId,
  sceneTitle: "Graph scene",
  excerpt: "The graph-only line.",
  canonicalRange: { start: 0, end: 20 },
  navigationIdentity: "nav-graph",
  path: { hop: 2, pinEntityId: "pin-g", edges: [edge("seed", "pin-g")] },
});

const rawScene = (sceneId: string) => ({
  sceneId,
  sceneTitle: `Raw ${sceneId}`,
  chunkText: `raw text ${sceneId}`,
  score: 0.9,
});
const irScene = (sceneId: string) => ({
  sceneId,
  sceneTitle: `IR ${sceneId}`,
  irCosine: 0.9,
  interpretation: {
    summary: "s",
    actuality: "a",
    attribution: "b",
    narrativeFrame: "c",
  },
  validatedEvidence: {
    excerpt: `ir text ${sceneId}`,
    navigationIdentity: `nav-${sceneId}`,
  },
  review: "human-approved" as const,
  freshness: "fresh" as const,
});

const fusedResult = (): Nir1RelatedScenesResult => ({
  kind: "fused",
  scenes: [
    // one row with both sources, then a Raw-only row
    {
      kind: "raw-ir",
      sceneId: "a",
      sceneTitle: "A",
      rank1: 1,
      raw: rawScene("a"),
      ir: irScene("a"),
    },
    {
      kind: "raw",
      sceneId: "b",
      sceneTitle: "B",
      rank1: 2,
      raw: rawScene("b"),
    },
  ],
  ir: { status: "available" },
});

function fetchOf(
  graph: Nir1RelatedScenesGraphPayload | undefined,
  overrides: Partial<Nir1RelatedScenesFetchResult> = {},
  result: Nir1RelatedScenesResult = fusedResult(),
): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "qb",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result,
    graphOutcome: "graph-ready",
    ...(graph ? { graph } : {}),
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 0, tReturnMs: 0 },
    ...overrides,
  } as Nir1RelatedScenesFetchResult;
}

const payload = (
  overrides: Partial<Nir1RelatedScenesGraphPayload> = {},
): Nir1RelatedScenesGraphPayload => ({
  queryBinding: "qb",
  pathAttachments: [],
  graphOnly: null,
  ...overrides,
});

describe("cp4 k64 probe: rowTextsOf", () => {
  it("lists a row's raw then ir source, then the displayed Graph-only row last", () => {
    const rows = rowTextsOf(
      fetchOf(payload({ graphOnly: graphOnly("g") })),
      "current",
    );
    expect(rows).toEqual([
      { sceneId: "a", kind: "raw", text: "raw text a" },
      { sceneId: "a", kind: "ir", text: "ir text a" },
      { sceneId: "b", kind: "raw", text: "raw text b" },
      { sceneId: "g", kind: "graph-only", text: "The graph-only line." },
    ]);
  });

  it("does not report a Graph-only row the fusion dropped (the IR used the common slot)", () => {
    const irUsedSlot: Nir1RelatedScenesResult = {
      kind: "fused",
      scenes: [
        {
          kind: "ir",
          sceneId: "i",
          sceneTitle: "I",
          rank1: 1,
          ir: irScene("i"),
        },
      ],
      ir: { status: "available" },
    };
    const rows = rowTextsOf(
      fetchOf(payload({ graphOnly: graphOnly("g") }), {}, irUsedSlot),
      "current",
    );
    expect(rows).toEqual([{ sceneId: "i", kind: "ir", text: "ir text i" }]);
  });

  it("reports the base rows as they are when the Graph is not ready", () => {
    const rows = rowTextsOf(
      fetchOf(undefined, { graphOutcome: "graph-timeout" } as never),
      "current",
    );
    expect(rows.map((row) => row.kind)).toEqual(["raw", "ir", "raw"]);
  });

  it("reads a Raw-only result's rows", () => {
    const rawOnly: Nir1RelatedScenesResult = {
      kind: "raw",
      scenes: [rawScene("a")],
      ir: { status: "empty" },
    };
    expect(rowTextsOf(fetchOf(undefined, {}, rawOnly), "current")).toEqual([
      { sceneId: "a", kind: "raw", text: "raw text a" },
    ]);
  });
});

describe("cp4 k64 probe: graphEvidenceOf", () => {
  it("reports the Graph-only row and the attachments the screen shows", () => {
    const evidence = graphEvidenceOf(
      fetchOf(
        payload({
          graphOnly: graphOnly("g"),
          pathAttachments: [attachment("b")],
        }),
      ),
      "current",
    );
    expect(evidence?.graphOnly?.sceneId).toBe("g");
    expect(evidence?.graphOnly?.hop).toBe(2);
    expect(evidence?.pathAttachments.map((row) => row.sceneId)).toEqual(["b"]);
  });

  it("does not report a Graph-only row the fusion dropped as displayed", () => {
    const irUsedSlot: Nir1RelatedScenesResult = {
      kind: "fused",
      scenes: [
        {
          kind: "ir",
          sceneId: "i",
          sceneTitle: "I",
          rank1: 1,
          ir: irScene("i"),
        },
      ],
      ir: { status: "available" },
    };
    const evidence = graphEvidenceOf(
      fetchOf(payload({ graphOnly: graphOnly("g") }), {}, irUsedSlot),
      "current",
    );
    expect(evidence).toEqual({ graphOnly: null, pathAttachments: [] });
  });

  it("does not report attachments when the fusion dropped the whole Graph contribution", () => {
    const evidence = graphEvidenceOf(
      fetchOf(
        payload({
          // an attachment to a Scene that is not displayed drops everything
          pathAttachments: [attachment("b"), attachment("not-shown")],
          graphOnly: graphOnly("g"),
        }),
      ),
      "current",
    );
    expect(evidence).toEqual({ graphOnly: null, pathAttachments: [] });
  });

  it("is null when the fetch had no Graph", () => {
    expect(graphEvidenceOf(fetchOf(undefined), "current")).toBeNull();
  });
});
