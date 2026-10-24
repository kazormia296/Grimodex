// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RelatedScenesGraphOnlyRow,
  RelatedScenesGraphPathEdge,
} from "@/../electron/shared/relatedScenesSearchWire";
import { useDebugLogStore } from "@/lib/debugLog";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

vi.mock("./nir1EvidenceNavigation", () => ({
  requestNir1EvidenceNavigation: vi.fn(),
}));
import Nir1GraphRelatedScenes from "./Nir1GraphRelatedScenes";
import { requestNir1EvidenceNavigation } from "./nir1EvidenceNavigation";

const edge = (
  from: string,
  to: string,
  quote: string,
  directionality = "directed",
): RelatedScenesGraphPathEdge => ({
  relationType: `rel-${from}`,
  directionality,
  from: { entityId: `id-${from}`, label: `Label ${from}` },
  to: { entityId: `id-${to}`, label: `Label ${to}` },
  evidence: [{ evidenceId: `ev-${from}`, quote }],
});
const graphOnly = (
  overrides: Partial<RelatedScenesGraphOnlyRow> = {},
): RelatedScenesGraphOnlyRow => ({
  sceneId: "g",
  sceneTitle: "Graph title",
  excerpt: "Graph excerpt text",
  canonicalRange: { start: 0, end: 18 },
  navigationIdentity: "nav-secret-handle",
  path: {
    hop: 2,
    pinEntityId: "id-pin",
    edges: [
      edge("seed", "mid", "Seed quote"),
      edge("mid", "pin", "Mid quote", "symmetric"),
    ],
  },
  ...overrides,
});
function fetchWith(
  overrides: Partial<Nir1RelatedScenesFetchResult> = {},
): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "qb",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result: {
      kind: "raw",
      scenes: [
        {
          sceneId: "a",
          sceneTitle: "Raw A",
          chunkText: "Raw body anchor A",
          score: 0.9,
        },
      ],
      ir: { status: "empty" },
    },
    graphOutcome: "graph-ready",
    graph: {
      queryBinding: "qb",
      pathAttachments: [
        { sceneId: "a", hop: 1, edges: [edge("seed", "pa", "Attach quote")] },
      ],
      graphOnly: graphOnly(),
    },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
    ...overrides,
  };
}
const view = (fetch = fetchWith()) =>
  render(<Nir1GraphRelatedScenes fetch={fetch} querySceneId="current" />);

beforeEach(() => {
  useDebugLogStore.getState().clear();
});
afterEach(() => cleanup());

describe("Nir1GraphRelatedScenes", () => {
  it("shows the path Evidence apart from the body anchor", () => {
    view();
    const rawRow = screen
      .getAllByTestId("related-scene-row")
      .find((row) => row.getAttribute("data-related-scene-id") === "a")!;
    const path = within(rawRow).getByTestId("nir1-graph-path");
    expect(path.textContent).toContain("Attach quote");
    expect(path.textContent).not.toContain("Raw body anchor A");
    // The body anchor is the row's own button, outside the path section.
    const anchor = within(rawRow).getByText("Raw body anchor A");
    expect(path.contains(anchor)).toBe(false);
  });

  it("path Evidence has no navigation control", () => {
    view();
    for (const path of screen.getAllByTestId("nir1-graph-path")) {
      expect(
        path.querySelectorAll("button, a, [role=button], [tabindex]"),
      ).toHaveLength(0);
    }
  });

  it("shows every edge and quote of the path with its direction in words", () => {
    view();
    const row = screen
      .getAllByTestId("related-scene-row")
      .find((item) => item.getAttribute("data-nir1-graph-only") === "true")!;
    const edges = within(row).getAllByTestId("nir1-graph-path-edge");
    expect(edges).toHaveLength(2);
    expect(
      within(row)
        .getAllByTestId("nir1-graph-relation-quote")
        .map((q) => q.textContent),
    ).toEqual(["Seed quote", "Mid quote"]);
    expect(edges[0].textContent).toContain("Label seed");
    expect(edges[0].textContent).toContain("Label mid");
    expect(edges[0].textContent).toContain("rel-seed");
    expect(
      within(edges[0]).getByText("一方向", { selector: ".sr-only" }),
    ).toBeTruthy();
    expect(
      within(edges[1]).getByText("双方向", { selector: ".sr-only" }),
    ).toBeTruthy();
  });

  it("the Graph-only row shows only the title, the excerpt and one open action", () => {
    view();
    const row = screen
      .getAllByTestId("related-scene-row")
      .find((item) => item.getAttribute("data-nir1-graph-only") === "true")!;
    expect(row.getAttribute("data-related-scene-id")).toBe("g");
    const path = within(row).getByTestId("nir1-graph-path");
    // Outside the path: the title, the fixed Graph mark, the rank, the fixed
    // excerpt label, the open action and the excerpt. Nothing else.
    const outside = (row.textContent ?? "").replace(path.textContent ?? "", "");
    expect(outside).toBe(
      [
        "Graph title",
        "Graph",
        "Graph が関係づけた Scene",
        "2位",
        "本文の該当箇所",
        "本文の該当箇所を開く",
        "Graph excerpt text",
      ].join(""),
    );
    expect(row.textContent).not.toContain("nav-secret-handle");
    // No Entity, Evidence or Scene ID is shown: labels and quotes only.
    for (const id of ["id-", "ev-", "data-"])
      expect(row.textContent).not.toContain(id);
    const open = within(row).getAllByRole("button");
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute("data-nir1-navigation-identity")).toBe(
      "nav-secret-handle",
    );
  });

  it("shows a fixed restart notice only for graph-unavailable:restart-required, and nothing for any other Graph reason", () => {
    const restart = view(
      fetchWith({
        graphOutcome: "graph-unavailable:restart-required",
        graph: undefined,
      }),
    );
    const notice = screen.getByTestId("nir1-graph-restart-required");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe(
      "Graph は Grimodex を再起動するまで使えません。保存できていない編集があれば、再起動の前に内容を控えてください。",
    );
    expect(screen.queryByTestId("nir1-graph-path")).toBeNull();
    restart.unmount();
    for (const graphOutcome of [
      "graph-unavailable:profile-not-restricted",
      "graph-unavailable:not-activated",
      "graph-unavailable:failed",
      "graph-late",
      "graph-ready",
    ] as const) {
      const rendered = view(fetchWith({ graphOutcome }));
      expect(screen.queryByTestId("nir1-graph-restart-required")).toBeNull();
      expect(document.body.textContent).not.toMatch(/activat|profile|有効化/i);
      rendered.unmount();
    }
  });

  it("a title with newlines, bidi controls or a long length stays one isolated line", () => {
    const title = `Evil\u202etitle\nsecond\u2066line${"x".repeat(400)}`;
    view(
      fetchWith({
        graph: {
          queryBinding: "qb",
          pathAttachments: [],
          graphOnly: graphOnly({
            sceneTitle: title,
            excerpt: "ab\u202ecd",
            canonicalRange: { start: 0, end: 5 },
            path: {
              hop: 1,
              pinEntityId: "id-pin",
              edges: [
                {
                  ...edge("seed", "pin", "q\u2067uote\u0007"),
                  from: { entityId: "seed", label: "la\u200fbel" },
                },
              ],
            },
          }),
        },
      }),
    );
    const row = screen
      .getAllByTestId("related-scene-row")
      .find((item) => item.getAttribute("data-nir1-graph-only") === "true")!;
    const titleNode = row.querySelector("bdi")!;
    expect(titleNode.parentElement?.className).toContain("truncate");
    expect(titleNode.textContent).toBe(
      `Evil title second line${"x".repeat(400)}`,
    );
    const text = row.textContent ?? "";
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u202e\u2066\u2067\u200f\u0007\n]/);
    expect(text).toContain("ab cd");
    expect(text).toContain("q uote ");
    expect(text).toContain("la bel");
    for (const bdi of row.querySelectorAll("bdi"))
      expect(bdi.tagName).toBe("BDI");
  });

  it("never writes the title, excerpt or path text to debugLog or storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    view(
      fetchWith({
        graph: {
          queryBinding: "qb",
          // An undisplayed attachment: the renderer narrows and logs counts.
          pathAttachments: [
            {
              sceneId: "zz",
              hop: 1,
              edges: [edge("seed", "zz", "Leak quote")],
            },
          ],
          graphOnly: graphOnly(),
        },
      }),
    );
    view();
    const entries = useDebugLogStore.getState().entries;
    expect(entries.length).toBeGreaterThan(0);
    const logged = JSON.stringify(entries);
    for (const secret of [
      "Graph title",
      "Graph excerpt text",
      "Leak quote",
      "Attach quote",
      "Label",
      "nav-secret-handle",
      "zz",
    ])
      expect(logged).not.toContain(secret);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it("never tells debugLog whether a Graph-only row existed, even when the renderer drops it (K2/4 MD2, MD9)", () => {
    // A Graph-only row for the query Scene itself: the renderer drops it.
    const dropped = graphOnly({ sceneId: "current" });
    const quiet = view(
      fetchWith({
        graph: { queryBinding: "qb", pathAttachments: [], graphOnly: dropped },
      }),
    );
    expect(screen.queryByTestId("nir1-graph-only-open")).toBeNull();
    expect(useDebugLogStore.getState().entries).toEqual([]);
    quiet.unmount();
    // With a narrowed attachment the log carries the attachment count only,
    // the same with or without a (dropped) Graph-only row.
    const details = [dropped, null].map((row) => {
      useDebugLogStore.getState().clear();
      const rendered = view(
        fetchWith({
          graph: {
            queryBinding: "qb",
            pathAttachments: [
              { sceneId: "zz", hop: 1, edges: [edge("seed", "zz", "q")] },
            ],
            graphOnly: row,
          },
        }),
      );
      const entries = useDebugLogStore.getState().entries;
      rendered.unmount();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe("graph contribution narrowed");
      expect(entries[0].detail).not.toMatch(/graphOnly/i);
      expect(JSON.parse(entries[0].detail!).fields).toEqual({ attachments: 1 });
      return entries[0].detail;
    });
    expect(details[0]).toBe(details[1]);
  });

  it("offers no chat, packing, snippet or copy action on a Graph row", () => {
    view();
    const rows = screen.getAllByTestId("related-scene-row");
    const graphRow = rows.find(
      (item) => item.getAttribute("data-nir1-graph-only") === "true",
    )!;
    expect(within(graphRow).getAllByRole("button")).toHaveLength(1);
    for (const row of rows) {
      const labels = Array.from(row.querySelectorAll("button, a"))
        .map(
          (node) =>
            `${node.textContent} ${node.getAttribute("aria-label") ?? ""}`,
        )
        .join(" ");
      expect(labels).not.toMatch(
        /chat|チャット|pack|snippet|スニペット|copy|コピー/i,
      );
    }
    expect(document.querySelector("[draggable=true]")).toBeNull();
  });
  it("the open action requests the Graph-only navigation with the row's range and excerpt", () => {
    const fetch = fetchWith();
    view(fetch);
    fireEvent.click(screen.getByTestId("nir1-graph-only-open"));
    expect(requestNir1EvidenceNavigation).toHaveBeenCalledExactlyOnceWith(
      fetch,
      "g",
      "nav-secret-handle",
      { canonicalRange: { start: 0, end: 18 }, excerpt: "Graph excerpt text" },
    );
  });
});
