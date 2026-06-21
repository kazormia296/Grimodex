// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
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

describe("DetailTabs", () => {
  // 回帰: タブが 5→8 に増えた結果、幅計測による畳み込みでアクティブ以外の
  // ラベルが消える状態になっていた。タブ数や幅に関係なく全タブのラベルを
  // 常に（sr-only でなく）表示することを gate する。
  it("renders every tab's label visibly, never icon-only collapsed", () => {
    const { getByTestId } = render(
      <DetailTabs tabs={TABS} activeTab="details" onTabChange={() => {}} />,
    );
    for (const tab of TABS) {
      const btn = getByTestId(tab.testId);
      const label = btn.querySelector("span");
      expect(label?.textContent).toBe(tab.label);
      // sr-only で a11y ツリーのみに退避させていないこと（視覚的に見えること）。
      expect(label?.className ?? "").not.toContain("sr-only");
    }
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
