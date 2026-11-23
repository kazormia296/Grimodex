/**
 * 実 Chromium で、起点を失った「AI に見せない」Phase の警告帯と行（DR-MP4-46、Q-G3）が、
 * 狭いサイドペイン幅で折り返し・はみ出し・コントラストを崩さないことを確かめる。
 * happy-dom は幅も色も計算しないので、ここだけが実測の置き場。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "@/lib/i18n";
import type { CodexEntry } from "@/features/codex/api";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { TimelineTab } from "./TimelineTab";

const phaseState = {
  phasesByEntry: {} as Record<string, CodexEntryPhase[]>,
  detailOverrides: {},
  sceneTimeIndex: buildSceneTimeIndex([
    {
      id: "scene-1",
      projectId: "p",
      parentId: null,
      nodeType: "scene",
      title: "第1場",
      synopsis: null,
      intent: null,
      sortOrder: "a0",
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]),
  resolutionMode: "reading" as const,
  loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
  deletePhase: vi.fn(),
};
vi.mock("../phaseStore", () => ({
  usePhaseStore: Object.assign(
    (selector: (s: typeof phaseState) => unknown) => selector(phaseState),
    { getState: () => phaseState },
  ),
}));
const treeState = { nodes: [], activeSceneId: "" };
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: Object.assign(
    (selector: (s: typeof treeState) => unknown) => selector(treeState),
    { getState: () => treeState },
  ),
}));

const entry = {
  id: "entry-1",
  projectId: "p",
  parentId: null,
  type: "character",
  name: "アリス",
  summary: "主人公",
  content: "{}",
  icon: null,
  aliases: "[]",
  excludedAliases: "[]",
  readings: null,
  tagsCache: null,
  contextMode: "mentioned",
  childrenBudget: "compact",
  sourceChatMessageId: null,
  notes: null,
  version: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
} as CodexEntry;

const phase = (
  id: string,
  label: string,
  anchorNodeId: string | null,
  contextModeOverride: string | null,
): CodexEntryPhase => ({
  id,
  entryId: "entry-1",
  label,
  anchorNodeId,
  summaryOverride: null,
  contentOverride: null,
  contextModeOverride,
  version: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
});

/** Any CSS color string (oklch, color-mix, ...) to RGBA through a canvas. */
function rgba(color: string): [number, number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
}
function luminance([r, g, b]: number[]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: number[], bg: number[]): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
/** The colour the notice's text sits on: its own tint blended over the page. */
function backgroundBehind(el: HTMLElement): number[] {
  const page = rgba(getComputedStyle(document.body).backgroundColor);
  const base = page[3] === 0 ? [255, 255, 255, 1] : page;
  const tint = rgba(getComputedStyle(el).backgroundColor);
  return [0, 1, 2].map((i) => tint[i] * tint[3] + base[i] * (1 - tint[3]));
}

afterEach(async () => {
  cleanup();
  document.documentElement.classList.remove("dark");
  await i18n.changeLanguage("ja");
});

describe("起点を失った Phase の表示（実 Chromium、狭いサイドペイン幅）", () => {
  for (const [lang, width] of [
    ["ja", 280],
    ["ja", 360],
    ["en", 280],
  ] as const) {
    for (const dark of [false, true]) {
      it(`${lang} / ${width}px / ${dark ? "dark" : "light"}: 警告帯と行が折り返してもはみ出さず、文字のコントラストが 4.5 以上`, async () => {
        await i18n.changeLanguage(lang);
        if (dark) document.documentElement.classList.add("dark");
        phaseState.phasesByEntry = {
          "entry-1": [
            phase(
              "p1",
              "正体の露見（長い名前の Phase でも折り返すこと）",
              null,
              "hidden",
            ),
            phase("p2", "二つ目", "scene-gone", "hidden"),
            phase("p3", "三つ目", null, "hidden"),
            phase("p4", "四つ目", null, "hidden"),
            phase("p5", "抑制", null, "suppress"),
          ],
        };
        render(
          <div
            data-testid="pane"
            style={{ width, padding: 12, boxSizing: "border-box" }}
            className="bg-background text-foreground"
          >
            <TimelineTab entry={entry} />
          </div>,
        );
        const banner = await screen.findByTestId(
          "orphaned-hiding-phase-notice-timeline",
        );
        // 言語が実際に切り替わっている（en の寸法を ja で測っていない）。
        expect(banner).toHaveTextContent(
          lang === "ja"
            ? "アプリ内の AI（チャット・エージェント・ビートなど）に渡りません"
            : "not sent to the in-app AI (chat, agents, beats, etc.)",
        );
        const pane = screen.getByTestId("pane");
        const paneRect = pane.getBoundingClientRect();

        // 折り返している（1 行に収まらず、横にはみ出さない）。
        expect(banner.scrollWidth).toBeLessThanOrEqual(banner.clientWidth);
        const bannerRect = banner.getBoundingClientRect();
        expect(bannerRect.right).toBeLessThanOrEqual(paneRect.right + 0.5);
        expect(bannerRect.left).toBeGreaterThanOrEqual(paneRect.left - 0.5);
        expect(bannerRect.height).toBeGreaterThan(60);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );

        // 末尾の行（原因別の文言＋回復の 1 文）。
        const reasons = screen.getAllByTestId("orphaned-phase-row-reason");
        expect(reasons.length).toBe(5);
        for (const el of [
          ...reasons,
          ...Array.from(pane.querySelectorAll("p")),
        ]) {
          const r = el.getBoundingClientRect();
          expect(r.right, el.textContent ?? "").toBeLessThanOrEqual(
            paneRect.right + 0.5,
          );
          expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth + 1);
        }

        // コントラスト: 本文（text-foreground）と帯の地、行の文字（muted）とペインの地。
        const bannerText = banner.querySelector(
          "p:last-of-type",
        ) as HTMLElement;
        const fg = rgba(getComputedStyle(bannerText).color);
        expect(contrast(fg, backgroundBehind(banner))).toBeGreaterThanOrEqual(
          4.5,
        );
        const rowFg = rgba(getComputedStyle(reasons[0]).color);
        const paneBg = rgba(getComputedStyle(pane).backgroundColor);
        expect(contrast(rowFg, paneBg)).toBeGreaterThanOrEqual(4.5);

        // 「AI 露出: n」バッジは出ない。
        expect(screen.queryByTestId("phase-exposure-ai")).toBeNull();
      });
    }
  }
});
