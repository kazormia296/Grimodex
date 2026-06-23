// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { UsageCategory } from "./UsageCategory";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string, fb?: string) => fb ?? k }),
}));

const { getProjectUsageSummary } = vi.hoisted(() => ({
  getProjectUsageSummary: vi.fn(),
}));

vi.mock("@/features/ai-usage/usageQuery", () => ({
  getProjectUsageSummary: (...a: unknown[]) => getProjectUsageSummary(...a),
}));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: (sel: (s: { projectId: string }) => unknown) =>
    sel({ projectId: "p1" }),
}));

// 子セクションはこのテストの対象外なので軽くスタブ。
vi.mock("@/features/ai-usage/BudgetEtaSection", () => ({
  BudgetEtaSection: () => null,
}));

describe("UsageCategory — error state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows an error message (not a blank panel) when the summary fetch rejects", async () => {
    getProjectUsageSummary.mockRejectedValue(new Error("db down"));

    render(<UsageCategory />);

    await waitFor(() => {
      expect(
        screen.getByText("使用状況の読み込みに失敗しました"),
      ).toBeInTheDocument();
    });
  });
});
