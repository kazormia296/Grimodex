// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IssuesInbox } from "./IssuesInbox";
import { useKouetsuStore } from "./kouetsuStore";

vi.mock("./KouetsuScopeBar", () => ({
  KouetsuScopeBar: () => <div data-testid="scope-bar" />,
}));
vi.mock("./sections/LinterSection", () => ({
  LinterSection: () => <div data-testid="sec-linter" />,
}));
vi.mock("./sections/TypoSection", () => ({
  TypoSection: () => <div data-testid="sec-typo" />,
}));
vi.mock("./sections/ConsistencySection", () => ({
  ConsistencySection: () => <div data-testid="sec-consistency" />,
}));
vi.mock("./sections/ImpactReviewSection", () => ({
  ImpactReviewSection: () => <div data-testid="sec-impact" />,
}));
vi.mock("./sections/ReviewSection", () => ({
  ReviewSection: () => <div data-testid="sec-review" />,
}));
vi.mock("./sections/IntentDriftSection", () => ({
  IntentDriftSection: () => <div data-testid="sec-intent" />,
}));
vi.mock("./sections/MetaStructureSection", () => ({
  MetaStructureSection: () => <div data-testid="sec-meta" />,
}));
vi.mock("./sections/TimelineConsistencySection", () => ({
  TimelineConsistencySection: () => <div data-testid="sec-timeline" />,
}));

beforeEach(() => {
  useKouetsuStore.setState({ scope: { type: "scene" }, statusFilter: "open" });
});

describe("IssuesInbox", () => {
  it("8 グループが機械系→批評系の順で並ぶ", () => {
    render(<IssuesInbox />);
    const headers = screen.getAllByRole("button", {
      name: /校正|誤字脱字|整合性|影響レビュー|レビュー|狙いズレ|メタ構造|時系列/,
    });
    expect(headers.length).toBeGreaterThanOrEqual(8);
    // 機械系 → 批評系の固定順を先頭 8 件で検証する。
    const order = headers
      .slice(0, 8)
      .map((h) => h.textContent?.replace(/\s+/g, "") ?? "");
    expect(order[0]).toContain("校正");
    expect(order[1]).toContain("誤字脱字");
    expect(order[2]).toContain("整合性");
    expect(order[3]).toContain("影響レビュー");
    expect(order[4]).toContain("レビュー");
    expect(order[5]).toContain("狙いズレ");
    expect(order[6]).toContain("メタ構造");
    expect(order[7]).toContain("時系列");
  });

  it("折りたたみ中のグループはビューを mount しない（既定: 校正/誤字/整合性のみ展開）", () => {
    render(<IssuesInbox />);
    expect(screen.getByTestId("sec-linter")).toBeInTheDocument();
    expect(screen.getByTestId("sec-typo")).toBeInTheDocument();
    expect(screen.getByTestId("sec-consistency")).toBeInTheDocument();
    expect(screen.queryByTestId("sec-impact")).toBeNull();
    expect(screen.queryByTestId("sec-review")).toBeNull();
    expect(screen.queryByTestId("sec-intent")).toBeNull();
    expect(screen.queryByTestId("sec-meta")).toBeNull();
    expect(screen.queryByTestId("sec-timeline")).toBeNull();
  });

  it("ヘッダクリックで展開するとビューが mount される", () => {
    render(<IssuesInbox />);
    // 「影響レビュー」と重複しないよう完全一致でレビュー見出しを引く。
    fireEvent.click(screen.getByRole("button", { name: "レビュー" }));
    expect(screen.getByTestId("sec-review")).toBeInTheDocument();
  });
});
