/**
 * 実 Chromium で、Graph chunk の先読みが済んでいれば、fetch が Graph の payload
 * を持ったとき fallback の R／R+IR の行が一度も commit されないことを確かめる
 * （DR-PUBG-37-1）。happy-dom の act は Suspense の fallback の throttle を飛ばす
 * ので、ここでは確かめられない。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("./fetchRelatedScenes", () => ({ fetchRelatedPastScenes: h.fetch }));
vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  listenRelatedScenesGraphReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));
vi.mock("./nir1GraphAvailability", () => ({
  NIR1_GRAPH_UI_ENABLED: false,
  isNir1GraphUiEnabled: () => true,
}));
vi.mock("./nir1GraphSeed", () => ({
  selectNir1GraphSeed: vi.fn(async () => null),
}));
import { RelatedScenesSection } from "./RelatedScenesSection";

const graphFetch = (): Nir1RelatedScenesFetchResult => ({
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
        chunkText: "Raw A text",
        score: 0.9,
      },
    ],
    ir: { status: "empty" },
  },
  graphOutcome: "graph-ready",
  graph: {
    queryBinding: "qb",
    pathAttachments: [],
    graphOnly: {
      sceneId: "g",
      sceneTitle: "Graph only title",
      excerpt: "Graph only excerpt",
      canonicalRange: { start: 0, end: 18 },
      navigationIdentity: "nav",
      path: {
        hop: 1,
        pinEntityId: "p",
        edges: [
          {
            relationType: "knows",
            directionality: "directed",
            from: { entityId: "s", label: "S" },
            to: { entityId: "p", label: "P" },
            evidence: [],
          },
        ],
      },
    },
  },
  session: null,
  timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
});

beforeEach(() => {
  // The updates arrive from real timers and promises, outside act().
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
  useTreeStore.setState({ activeSceneId: "current", nodes: [] } as never);
});
afterEach(() => {
  cleanup();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe("RelatedScenesSection with the Graph chunks preloaded", () => {
  it("never commits the R/R+IR rows as a fallback before the Graph row", async () => {
    let release: (value: Nir1RelatedScenesFetchResult) => void = () => {};
    h.fetch.mockReturnValue(
      new Promise<Nir1RelatedScenesFetchResult>((resolve) => {
        release = resolve;
      }),
    );
    const { container } = render(<RelatedScenesSection />);
    // The preload is requested at mount; wait for it to have landed.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const violations: string[] = [];
    let sawGraphRow = false;
    const check = () => {
      const raw = container.querySelector('[data-related-scene-id="a"]');
      const graph = container.querySelector(
        '[data-testid="nir1-graph-only-open"]',
      );
      if (graph) sawGraphRow = true;
      if (raw && !graph) violations.push(container.innerHTML.slice(0, 200));
    };
    const observer = new MutationObserver(check);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    release(graphFetch());
    await vi.waitFor(() => expect(sawGraphRow).toBe(true), { timeout: 3000 });
    // Past the fallback throttle: nothing may show up late either.
    await new Promise((resolve) => setTimeout(resolve, 500));
    observer.disconnect();
    expect(violations).toEqual([]);
  });
});
