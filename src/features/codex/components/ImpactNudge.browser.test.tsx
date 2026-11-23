/**
 * 実 Chromium で、影響チェックの「前回のチェック以降に N 件の変更があります」の 1 行と
 * 整合性タブの点（DR-INN-1）の見た目の崩れを gate する。happy-dom は flex／max-content の
 * 実寸を持たないため、はみ出し・折り返し・タブの幅の不変・コントラストは実ブラウザでしか測れない。
 *
 * 画面を目視したいとき: `VITE_IMPACT_NUDGE_SHOT=<この file からの相対 dir>` を付けて実行すると
 * その dir に PNG を保存する（CI では保存しない）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import i18next from "i18next";
import {
  AlertTriangle,
  AtSign,
  CalendarClock,
  Crosshair,
  FileText,
  LineSquiggle,
  Microscope,
  Network,
} from "lucide-react";

vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null }),
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({ blockIfUnlicensed: () => false }));
vi.mock("@/features/post-effect/api", () => ({
  flushPendingSceneSaves: async () => undefined,
}));
vi.mock("@/features/impact-review/runImpactReview", () => ({
  runImpactReview: vi.fn(),
}));
const readMock = vi.hoisted(() => ({
  value: { state: "pending", changeCount: 12 } as {
    state: string;
    changeCount?: number;
  },
}));
vi.mock("@/features/impact-review/readImpactPending", () => ({
  readImpactPending: async () => readMock.value,
}));

import { DetailTabs } from "./DetailTabs";
import { ImpactCheckButton } from "./ImpactCheckButton";
import { ImpactPendingTabMarker } from "./ImpactPendingTabMarker";

const SHOT_DIR = import.meta.env.VITE_IMPACT_NUDGE_SHOT as string | undefined;

function tabs(withMarker: boolean, full = false) {
  const marker = withMarker ? (
    <ImpactPendingTabMarker entryId="e1" refreshKey="k" />
  ) : undefined;
  const consistency = {
    id: "consistency",
    label: "整合性",
    testId: "detail-tab-consistency",
    icon: AlertTriangle,
    marker,
  };
  const details = {
    id: "details",
    label: "詳細",
    testId: "detail-tab-details",
    icon: FileText,
  };
  if (!full) return [details, consistency];
  // CodexDetailContent.getTabs() と同じ 8 タブ構成（狭幅では非アクティブがアイコンのみに畳まれる）。
  return [
    details,
    {
      id: "relations",
      label: "リレーション",
      testId: "detail-tab-relations",
      icon: Network,
    },
    {
      id: "tracking",
      label: "トラッキング",
      testId: "detail-tab-tracking",
      icon: Crosshair,
    },
    {
      id: "mentions",
      label: "言及",
      testId: "detail-tab-mentions",
      icon: AtSign,
    },
    {
      id: "research",
      label: "リサーチ",
      testId: "detail-tab-research",
      icon: Microscope,
    },
    {
      id: "timeline",
      label: "タイムライン",
      testId: "detail-tab-timeline",
      icon: CalendarClock,
    },
    {
      id: "foreshadow",
      label: "伏線",
      testId: "detail-tab-foreshadow",
      icon: LineSquiggle,
    },
    consistency,
  ];
}

function Panel({
  width,
  withMarker = true,
  full = false,
  activeTab = "consistency",
}: {
  width: number;
  withMarker?: boolean;
  full?: boolean;
  activeTab?: string;
}) {
  return (
    <div
      data-testid="panel"
      style={{ width, position: "fixed", top: 0, left: 0 }}
      className="bg-background p-3 text-foreground"
    >
      <DetailTabs
        tabs={tabs(withMarker, full)}
        activeTab={activeTab}
        onTabChange={() => {}}
      />
      <div className="space-y-3 py-3">
        <ImpactCheckButton entryId="e1" />
      </div>
    </div>
  );
}

function rgbOf(cssColor: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort(
    (x, y) => y - x,
  );
  return (l1 + 0.05) / (l2 + 0.05);
}
function resolvedVar(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  const v = getComputedStyle(probe).color;
  probe.remove();
  return v;
}

beforeEach(() => {
  readMock.value = { state: "pending", changeCount: 12 };
});
afterEach(async () => {
  cleanup();
  document.documentElement.classList.remove("dark");
  await i18next.changeLanguage("ja");
});

const WIDTHS = [1100, 320, 220];

describe("ImpactNudge の見た目（実 Chromium）", () => {
  for (const lang of ["ja", "en"] as const) {
    for (const width of WIDTHS) {
      it(`${lang} / 幅 ${width}: 1 行は親からはみ出さず、点はタブのボタンの内側に収まる`, async () => {
        await i18next.changeLanguage(lang);
        const { getByTestId } = render(<Panel width={width} />);
        const line = await waitFor(() =>
          getByTestId("codex-impact-check-pending"),
        );
        await waitFor(() => getByTestId("detail-tab-pending-dot"));

        const panel = getByTestId("panel").getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        const button =
          getByTestId("codex-impact-check").getBoundingClientRect();
        // 横にはみ出さない（親の中身の幅の内側）。
        expect(lineRect.left).toBeGreaterThanOrEqual(panel.left - 0.5);
        expect(lineRect.right).toBeLessThanOrEqual(panel.right + 0.5);
        expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth + 1);
        // 1 行はボタンの上にあり、重ならない。
        expect(lineRect.bottom).toBeLessThanOrEqual(button.top + 0.5);
        // ボタンの幅は 1 行の有無で変わらない（親の幅いっぱい）。
        expect(Math.abs(button.width - (panel.width - 24))).toBeLessThan(1.5);
        // ページ全体に横スクロールが出ない。
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );

        const tab = getByTestId(
          "detail-tab-consistency",
        ).getBoundingClientRect();
        const dot = getByTestId(
          "detail-tab-pending-dot",
        ).getBoundingClientRect();
        expect(dot.width).toBeGreaterThan(0);
        expect(dot.left).toBeGreaterThanOrEqual(tab.left);
        expect(dot.right).toBeLessThanOrEqual(tab.right);
        expect(dot.top).toBeGreaterThanOrEqual(tab.top);
        expect(dot.bottom).toBeLessThanOrEqual(tab.bottom);
        // 点がアイコンに重ならない位置（ボタンの padding の内側）。
        const icon = getByTestId("detail-tab-consistency")
          .querySelector("svg")!
          .getBoundingClientRect();
        expect(dot.left).toBeGreaterThanOrEqual(icon.right - 0.5);
      });
    }
  }

  it("点を足してもタブの幅・位置は変わらない（畳み込みの計測に影響しない）", async () => {
    const withDot = render(<Panel width={240} withMarker />);
    await waitFor(() => withDot.getByTestId("detail-tab-pending-dot"));
    const a = ["detail-tab-details", "detail-tab-consistency"].map((id) => {
      const r = withDot.getByTestId(id).getBoundingClientRect();
      return [r.left, r.width];
    });
    withDot.unmount();
    const without = render(<Panel width={240} withMarker={false} />);
    const b = ["detail-tab-details", "detail-tab-consistency"].map((id) => {
      const r = without.getByTestId(id).getBoundingClientRect();
      return [r.left, r.width];
    });
    expect(a).toEqual(b);
  });

  it.each(["light", "dark"] as const)(
    "%s: 文字と点のコントラストが足りる",
    async (theme) => {
      if (theme === "dark") document.documentElement.classList.add("dark");
      const { getByTestId } = render(<Panel width={320} />);
      const line = await waitFor(() =>
        getByTestId("codex-impact-check-pending"),
      );
      const bg = resolvedVar("--background");
      expect(contrast(getComputedStyle(line).color, bg)).toBeGreaterThanOrEqual(
        4.5,
      );
      await waitFor(() => getByTestId("detail-tab-pending-dot"));
      const dotBg = getComputedStyle(
        getByTestId("detail-tab-pending-dot"),
      ).backgroundColor;
      expect(contrast(dotBg, bg)).toBeGreaterThanOrEqual(3);
    },
  );

  it.each([1100, 240])(
    "8 タブ・詳細がアクティブ・幅 %i: 非アクティブの整合性タブ（アイコンのみに畳まれる幅でも）の点がタブの内側に収まり、marker の有無で各タブの畳み込みと幅が変わらない",
    async (width) => {
      const withDot = render(<Panel width={width} full activeTab="details" />);
      await waitFor(() => withDot.getByTestId("detail-tab-pending-dot"));
      const ids = [
        "detail-tab-details",
        "detail-tab-relations",
        "detail-tab-tracking",
        "detail-tab-mentions",
        "detail-tab-research",
        "detail-tab-timeline",
        "detail-tab-foreshadow",
        "detail-tab-consistency",
      ];
      const labelCollapsed = (id: string) =>
        withDot
          .getByTestId(id)
          .querySelector("button > span:not([aria-hidden])")
          ?.classList.contains("sr-only") ?? false;
      const snap = (r: typeof withDot) =>
        ids.map((id) => {
          const rect = r.getByTestId(id).getBoundingClientRect();
          return [id, rect.left, rect.width];
        });
      const a = snap(withDot);
      const collapsedA = ids.map(labelCollapsed);
      if (width === 240) {
        // 畳み込みが起きている幅であること（詳細だけラベルが残る）。
        expect(collapsedA[ids.length - 1]).toBe(true);
        expect(collapsedA[0]).toBe(false);
      }
      const tab = withDot
        .getByTestId("detail-tab-consistency")
        .getBoundingClientRect();
      const dot = withDot
        .getByTestId("detail-tab-pending-dot")
        .getBoundingClientRect();
      expect(dot.left).toBeGreaterThanOrEqual(tab.left);
      expect(dot.right).toBeLessThanOrEqual(tab.right);
      expect(dot.top).toBeGreaterThanOrEqual(tab.top);
      expect(dot.bottom).toBeLessThanOrEqual(tab.bottom);
      withDot.unmount();

      const without = render(
        <Panel width={width} full activeTab="details" withMarker={false} />,
      );
      await waitFor(() => without.getByTestId("detail-tab-consistency"));
      expect(snap(without)).toEqual(a);
      expect(ids.map(labelCollapsed)).toEqual(collapsedA);
    },
  );

  it("変更が無ければ 1 行も点も出ない（ボタンだけ）", async () => {
    readMock.value = { state: "none" };
    const { getByTestId, queryByTestId } = render(<Panel width={320} />);
    await waitFor(() => getByTestId("codex-impact-check"));
    await new Promise((r) => setTimeout(r, 50));
    expect(queryByTestId("codex-impact-check-pending")).toBeNull();
    expect(queryByTestId("detail-tab-pending-dot")).toBeNull();
  });

  // `it.skipIf` は skip（pending）として数えられ、browser CI の benchmark（allTestsPassed）が
  // 「pending が 0 件」を要求して job が落ちる。env を付けたときだけ試験を登録する。
  if (SHOT_DIR)
    it("目視用のスクリーンショットを保存する", async () => {
      for (const lang of ["ja", "en"] as const) {
        for (const theme of ["light", "dark"] as const) {
          await i18next.changeLanguage(lang);
          document.documentElement.classList.toggle("dark", theme === "dark");
          const { getByTestId, unmount } = render(<Panel width={360} />);
          await waitFor(() => getByTestId("codex-impact-check-pending"));
          await waitFor(() => getByTestId("detail-tab-pending-dot"));
          await page.screenshot({
            element: getByTestId("panel"),
            path: `${SHOT_DIR}/impact-nudge-${lang}-${theme}.png`,
          });
          unmount();
        }
      }
      // 作者が最もよく見る状態: 詳細タブにいて、整合性タブは非アクティブ（8 タブ）。
      await page.viewport(1000, 400);
      for (const width of [900, 240]) {
        await i18next.changeLanguage("ja");
        document.documentElement.classList.remove("dark");
        const { getByTestId, unmount } = render(
          <Panel width={width} full activeTab="details" />,
        );
        await waitFor(() => getByTestId("detail-tab-pending-dot"));
        await page.screenshot({
          element: getByTestId("panel"),
          path: `${SHOT_DIR}/impact-nudge-8tabs-details-active-${width}.png`,
        });
        unmount();
      }
    });
});
