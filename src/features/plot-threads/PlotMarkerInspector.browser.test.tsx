/**
 * 実 Chromium で動かす PlotMarkerInspector のスクロール invariant テスト。
 *
 * バグ: threads モードのマーカーインスペクタ root に overflow-y-auto が無く、
 * 高さの bounded な親 row (flex-1 + overflow-hidden) の中で内容ぶんだけ縦に
 * 伸びてクリップされ、スクロールできなかった (2026-06-24 報告)。
 *
 * happy-dom は flex の実寸を計算しないため scrollHeight/clientHeight が常に 0 で
 * このバグを再現できない。ここでは TimelinePanel と同じレイアウト構造
 * (h-full flex-col overflow-hidden → flex-1 overflow-hidden row → inspector) を
 * 実描画し、内容が溢れたとき inspector が「スクロールコンテナになる」
 * (scrollHeight > clientHeight) かつ「親の高さに収まる」(clientHeight <= 親) こと
 * を実ブラウザで gate する。
 *
 * 修正前: overflow が無いので inspector が内容高さまで伸び、scrollHeight ==
 * clientHeight かつ clientHeight が親を超える → 両 assert が落ちる。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { PlotMarkerInspector } from "./PlotMarkerInspector";
import { usePlotThreadStore } from "./plotThreadStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import type { PlotThreadRow, PlotThreadLinkRow } from "./api";

// tauri モジュールを丸ごと差し替えるので、推移的に取り込まれるモジュールが
// 静的 import する値エクスポート（listen/emit）も漏れなく与える。欠けると
// "does not provide an export named 'listen'" で suite ごと import 失敗する。
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(),
  isTauri: () => false,
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

const thread: PlotThreadRow = {
  id: "t1",
  projectId: "p1",
  name: "復讐の糸",
  color: null,
  description: null,
  sortOrder: "a0",
  startNodeId: null,
  endNodeId: null,
  version: 0,
  createdAt: "",
  updatedAt: "",
};
const link: PlotThreadLinkRow = {
  id: "l1",
  threadId: "t1",
  nodeId: "s1",
  phaseType: "introduce",
  note: null,
  sortOrder: null,
  semanticKey: "",
  version: 0,
  createdAt: "",
  updatedAt: "",
};

const PANEL_HEIGHT = 150;

function renderInBoundedPanel() {
  return render(
    // TimelinePanel と同じ入れ子: 高さ固定の flex-col → flex-1 の row。
    <div
      style={{ height: `${PANEL_HEIGHT}px` }}
      className="flex flex-col overflow-hidden"
    >
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1" />
        <PlotMarkerInspector width={224} onClose={() => {}} />
      </div>
    </div>,
  );
}

describe("PlotMarkerInspector – 内容が溢れたらスクロールできる", () => {
  beforeEach(() => {
    usePlotThreadStore.setState({ threads: [thread], links: [link] });
    useTimelineStore.setState({
      selectedPlotLinkId: "l1",
      selectedPlotThreadId: null,
    });
  });
  afterEach(cleanup);

  it("狭い親の中でスクロールコンテナになり、高さが親に収まる", () => {
    const { getByTestId } = renderInBoundedPanel();
    const insp = getByTestId("plot-marker-inspector");

    // 内容 (スレッド + マーカーの各フィールド) は 150px に収まらないので溢れる。
    // 溢れぶんが overflow-y-auto でスクロールできること:
    expect(insp.scrollHeight).toBeGreaterThan(insp.clientHeight);
    // 親 row の高さを超えて伸びていない (クリップではなくスクロールになっている):
    expect(insp.clientHeight).toBeLessThanOrEqual(PANEL_HEIGHT);
  });
});
