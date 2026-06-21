/**
 * 実 Chromium で DetailTabs のレスポンシブなラベル畳み込みを gate する。
 *
 * 回帰: タブが 5→8 に増えた後、一時的に「常時フルラベル + 横スクロール」へ
 * 変えてしまい、狭幅でアクティブ以外がアイコン化しなくなった (#162)。本来の挙動は
 * 「十分広い時は全タブ icon+label / 狭い時はアクティブ以外を sr-only(アイコンのみ)
 * に畳む」。
 *
 * happy-dom は flex / max-content の実寸を計算できず useFitsInline が常に
 * fits=true になるため、この幅依存の挙動は実ブラウザでしか検証できない。
 * （browser config は Tailwind Vite plugin を読むのでユーティリティが効く。）
 */
import { describe, it, expect, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  FileText,
  Network,
  Crosshair,
  AtSign,
  Microscope,
  CalendarClock,
  LineSquiggle,
  AlertTriangle,
} from "lucide-react";
import { DetailTabs } from "./DetailTabs";

// CodexDetailContent.getTabs() と同じ 8 タブ構成。
const TABS = [
  {
    id: "details",
    label: "詳細",
    testId: "detail-tab-details",
    icon: FileText,
  },
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
  {
    id: "consistency",
    label: "整合性",
    testId: "detail-tab-consistency",
    icon: AlertTriangle,
  },
];

function renderAt(width: number) {
  return render(
    <div style={{ position: "fixed", top: 0, left: 0, width }}>
      <DetailTabs tabs={TABS} activeTab="details" onTabChange={() => {}} />
    </div>,
  );
}

/** ボタン内ラベル span が sr-only(=アイコンのみ表示) に畳まれているか。 */
function labelCollapsed(container: HTMLElement, testId: string): boolean {
  const span = container.querySelector(`[data-testid="${testId}"] span`);
  if (!span) throw new Error(`label span not found for ${testId}`);
  return span.classList.contains("sr-only");
}

describe("DetailTabs responsive label collapse (real Chromium)", () => {
  it("shows every tab's label when there is ample width", async () => {
    const { container } = renderAt(1100);
    await waitFor(() => {
      for (const tab of TABS) {
        expect(labelCollapsed(container, tab.testId)).toBe(false);
      }
    });
  });

  it("collapses non-active tabs to icon-only when too narrow (active keeps its label)", async () => {
    const { container } = renderAt(240);
    // アクティブ以外がアイコン化するまで待つ（計測 + ResizeObserver 反映）。
    await waitFor(() => {
      expect(labelCollapsed(container, "detail-tab-consistency")).toBe(true);
    });
    // アクティブ(details)は現在地が分かるようラベルを維持。
    expect(labelCollapsed(container, "detail-tab-details")).toBe(false);
    // 他の非アクティブもアイコンのみ。
    expect(labelCollapsed(container, "detail-tab-relations")).toBe(true);
  });

  it("calls onTabChange with the tab id when a non-active tab is clicked", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <DetailTabs tabs={TABS} activeTab="details" onTabChange={onChange} />,
    );
    getByTestId("detail-tab-consistency").click();
    expect(onChange).toHaveBeenCalledWith("consistency");
  });
});
