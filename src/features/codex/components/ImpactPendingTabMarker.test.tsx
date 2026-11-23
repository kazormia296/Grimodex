// @vitest-environment happy-dom
/**
 * 整合性タブの点（DR-INN-1）。DetailTabs の表示用の列にだけ描画され、条件は
 * ボタン上の 1 行と同じ判定（useImpactPending）に従う。
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AlertTriangle, FileText } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => ({ presentation: "enabled" as string }));
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: gate.presentation, tooltip: null }),
}));
vi.mock("@/features/impact-review/readImpactPending", () => ({
  readImpactPending: vi.fn(),
}));

import { readImpactPending } from "@/features/impact-review/readImpactPending";
import { useImpactPendingEpochStore } from "@/features/impact-review/impactPendingEpoch";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import { DetailTabs } from "./DetailTabs";
import { ImpactPendingTabMarker } from "./ImpactPendingTabMarker";

function tabs(entryId: string, refreshKey: string) {
  return [
    {
      id: "details",
      label: "詳細",
      testId: "detail-tab-details",
      icon: FileText,
    },
    {
      id: "consistency",
      label: "整合性",
      testId: "detail-tab-consistency",
      icon: AlertTriangle,
      marker: (
        <ImpactPendingTabMarker entryId={entryId} refreshKey={refreshKey} />
      ),
    },
  ];
}

const DOT = "detail-tab-pending-dot";

beforeEach(() => {
  vi.clearAllMocks();
  gate.presentation = "enabled";
  usePostEffectRunStore.setState({ runs: {} });
  vi.mocked(readImpactPending).mockResolvedValue({
    state: "pending",
    changeCount: 2,
  });
});
afterEach(() => cleanup());

describe("ImpactPendingTabMarker", () => {
  it("変更があれば、整合性タブのボタンの中に点（aria-hidden）と sr-only の語を出す", async () => {
    render(
      <DetailTabs
        tabs={tabs("e1", "details:t1")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    const dot = await screen.findByTestId(DOT);
    expect(dot).toHaveAttribute("aria-hidden", "true");
    const tab = screen.getByTestId("detail-tab-consistency");
    expect(tab).toContainElement(dot);
    expect(tab).toHaveTextContent("影響チェックが未実施の変更があります");
    // 他のタブには出ない。
    expect(screen.getByTestId("detail-tab-details")).not.toContainElement(dot);
    // 計測用の隠し行には出ない（点は 1 つだけ）。
    expect(screen.getAllByTestId(DOT)).toHaveLength(1);
  });

  it.each([
    ["none", { state: "none" }],
    ["unchecked", { state: "unchecked" }],
    ["gated", { state: "gated", reason: "context-mode" }],
  ] as const)("%s では点を出さない", async (_n, value) => {
    vi.mocked(readImpactPending).mockResolvedValue(value as never);
    render(
      <DetailTabs
        tabs={tabs("e1", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await waitFor(() => expect(readImpactPending).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId(DOT)).toBeNull();
  });

  it("AI gate が enabled でなければ読まず、点も出さない", async () => {
    gate.presentation = "disabled";
    render(
      <DetailTabs
        tabs={tabs("e1", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await act(async () => {});
    expect(readImpactPending).not.toHaveBeenCalled();
    expect(screen.queryByTestId(DOT)).toBeNull();
  });

  it("読みの失敗は表示なし", async () => {
    vi.mocked(readImpactPending).mockRejectedValue(new Error("boom"));
    render(
      <DetailTabs
        tabs={tabs("e1", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await waitFor(() => expect(readImpactPending).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId(DOT)).toBeNull();
  });

  it("タブ切替（refreshKey の変化）で再計算し、変更が戻れば点が消える", async () => {
    const { rerender } = render(
      <DetailTabs
        tabs={tabs("e1", "details:t1")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await screen.findByTestId(DOT);
    vi.mocked(readImpactPending).mockResolvedValue({ state: "none" });
    rerender(
      <DetailTabs
        tabs={tabs("e1", "relations:t1")}
        activeTab="relations"
        onTabChange={() => {}}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId(DOT)).toBeNull(), {
      timeout: 3000,
    });
    expect(readImpactPending).toHaveBeenCalledTimes(2);
  });

  it("押下完了の合図（epoch）でも再計算する", async () => {
    render(
      <DetailTabs
        tabs={tabs("e1", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await screen.findByTestId(DOT);
    vi.mocked(readImpactPending).mockResolvedValue({ state: "none" });
    act(() => useImpactPendingEpochStore.getState().bump());
    await waitFor(() => expect(screen.queryByTestId(DOT)).toBeNull(), {
      timeout: 3000,
    });
  });

  it("entryId が変わったら、前の項目の点を出さない", async () => {
    const { rerender } = render(
      <DetailTabs
        tabs={tabs("e1", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    await screen.findByTestId(DOT);
    vi.mocked(readImpactPending).mockReturnValue(new Promise(() => {}));
    rerender(
      <DetailTabs
        tabs={tabs("e2", "k")}
        activeTab="details"
        onTabChange={() => {}}
      />,
    );
    expect(screen.queryByTestId(DOT)).toBeNull();
  });
});
