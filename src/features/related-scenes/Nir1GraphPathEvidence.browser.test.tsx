/**
 * 実 Chromium で動かす Related Scenes の Graph の行（CP-3b）の幾何 invariant。
 *
 * happy-dom は flex の寸法を計算しないため、狭い Scene context の幅での横の
 * はみ出し、Graph-only の行の幅、64 KiB の excerpt の折り畳み（高さ）と描画の
 * 負荷は実ブラウザで測る（U-8）。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { RelatedScenesGraphPathEdge } from "@/../electron/shared/relatedScenesSearchWire";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

vi.mock("./nir1EvidenceNavigation", () => ({
  requestNir1EvidenceNavigation: vi.fn(),
}));
import Nir1GraphRelatedScenes from "./Nir1GraphRelatedScenes";

const WIDTHS = [240, 320, 520] as const;
const EPSILON = 0.75;
const LONG = "長".repeat(300);
const EXCERPT = "本文の一つ目の段落。".repeat(6554).slice(0, 65536);

const edge = (from: string, to: string): RelatedScenesGraphPathEdge => ({
  relationType: `relation-${LONG}`,
  directionality: "directed",
  from: { entityId: from, label: `${from}-${LONG}` },
  to: { entityId: to, label: `${to}-${LONG}` },
  evidence: [
    { evidenceId: `${from}-1`, quote: `quote-${LONG}${LONG}` },
    { evidenceId: `${from}-2`, quote: "short quote" },
  ],
});

const fetchResult = (): Nir1RelatedScenesFetchResult => ({
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
        sceneTitle: `Raw ${LONG}`,
        chunkText: `Raw body ${LONG}`,
        score: 0.9,
      },
    ],
    ir: { status: "empty" },
  },
  graphOutcome: "graph-ready",
  graph: {
    queryBinding: "qb",
    pathAttachments: [{ sceneId: "a", hop: 1, edges: [edge("s", "a")] }],
    graphOnly: {
      sceneId: "g",
      sceneTitle: `Graph ${LONG}`,
      excerpt: EXCERPT,
      canonicalRange: { start: 0, end: EXCERPT.length },
      navigationIdentity: "nav",
      path: {
        hop: 2,
        pinEntityId: "p",
        edges: [edge("s", "m"), edge("m", "p")],
      },
    },
  },
  session: null,
  timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
});

function clipped(el: Element, host: Element): boolean {
  for (let at = el.parentElement; at && at !== host; at = at.parentElement)
    if (getComputedStyle(at).overflowX !== "visible") return true;
  return false;
}

function mountAt(width: number) {
  return render(
    <div
      data-test-host
      className="flex flex-col"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width,
        boxSizing: "border-box",
      }}
    >
      <div className="py-1">
        <Nir1GraphRelatedScenes fetch={fetchResult()} querySceneId="current" />
      </div>
    </div>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("ja");
});
afterEach(() => cleanup());

describe("U-8 the Graph rows fit a narrow Scene context panel", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      it(`${lang} ${width}px`, async () => {
        await i18n.changeLanguage(lang);
        const started = performance.now();
        const { container } = mountAt(width);
        const rows = await screen.findAllByTestId("related-scene-row");
        const elapsed = performance.now() - started;
        const host = container.querySelector("[data-test-host]") as HTMLElement;
        expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
        const hostRect = host.getBoundingClientRect();
        for (const el of host.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          // `sr-only` text is clipped to 1px and positioned absolutely; the
          // inside of a clipping box (`truncate`) is checked by the box itself.
          if (el.closest(".sr-only") || clipped(el, host)) continue;
          expect(
            r.right,
            `${el.tagName}.${el.className} ${el.textContent?.slice(0, 30)}`,
          ).toBeLessThanOrEqual(hostRect.right + EPSILON);
          expect(r.left).toBeGreaterThanOrEqual(hostRect.left - EPSILON);
        }
        // Text that runs past its own box (not clipped on purpose).
        const offenders = [...host.querySelectorAll("*")]
          .filter((el) => getComputedStyle(el).overflowX === "visible")
          .filter((el) => !el.closest(".sr-only") && !clipped(el, host))
          .filter(
            (el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0,
          )
          .map((el) => `${el.tagName}:${el.scrollWidth}/${el.clientWidth}`);
        expect(offenders).toEqual([]);
        const [rawRow, graphRow] = rows;
        expect(graphRow.getAttribute("data-nir1-graph-only")).toBe("true");
        const rawRect = rawRow.getBoundingClientRect();
        const graphRect = graphRow.getBoundingClientRect();
        expect(Math.abs(graphRect.width - rawRect.width)).toBeLessThanOrEqual(
          1,
        );
        // A 64 KiB excerpt is folded by lines, not drawn in full.
        const open = screen.getByTestId("nir1-graph-only-open");
        expect(open.getBoundingClientRect().height).toBeLessThan(120);
        expect(open.textContent?.length).toBeGreaterThanOrEqual(65536);
        for (const quote of screen.getAllByTestId("nir1-graph-relation-quote"))
          expect(quote.getBoundingClientRect().height).toBeLessThan(80);
        expect(elapsed).toBeLessThan(3000);
      });
    }
  }
});
