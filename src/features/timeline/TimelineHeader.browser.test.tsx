/**
 * 実 Chromium で動かす TimelineHeader の幾何 invariant テスト。
 *
 * バグ: パネルが狭いと flex の子が min-content (CJK は 1 文字幅) まで潰れ、
 * 「タイムライン」「スレッド」「40 シーン」が縦書きのように 1 文字ずつ
 * 折り返してしまう (temp スクリーンショット 2026-06-24 で報告)。
 *
 * happy-dom は flex の実寸を計算しないためこの折り返しを再現できない。ここでは
 * 狭幅コンテナに実描画し、各テキスト要素の `getBoundingClientRect().height` が
 * 1 行分に収まる (= 縦積みしていない) ことを実ブラウザで gate する。
 *
 * 修正方針 (MapHeader と同じ): コンテナを flex-wrap にし、各子に shrink-0 +
 * whitespace-nowrap を付けて min-content への潰れを禁止する。狭いときは
 * 折り返して 2 段になるが、文字単位の縦割れは起きない。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TimelineHeader } from "./TimelineHeader";
import { useTimelineStore } from "./timelineStore";

// text-xs の 1 行は line-height 16px。py-0.5 のボタンでも ~20px。文字が縦に
// 2 文字以上積まれると 32px を超えるため、これを縦割れ検出の閾値にする。
const SINGLE_LINE_MAX = 30;

function resetStore() {
  useTimelineStore.setState({
    axisMode: "reading",
    spacingMode: "uniform",
    showThreads: false,
    zoom: 1,
    scrollOffset: 0,
    selectedNodeIds: [],
    inspectorOpen: false,
    display: {
      showTitles: true,
      showChapterNumbers: true,
      showPhasePins: false,
    },
  });
}

function renderNarrow(width: number) {
  return render(
    <div style={{ width: `${width}px` }}>
      <TimelineHeader
        sceneCount={40}
        scheduledCount={null}
        inspectorOpen={false}
        onToggleInspector={() => {}}
      />
    </div>,
  );
}

describe("TimelineHeader – 狭幅で文字が縦割れしない", () => {
  beforeEach(resetStore);
  afterEach(cleanup);

  it("幅 360px でもタイトル/トグル/件数が 1 行に収まる", () => {
    renderNarrow(360);

    // タイトル「タイムライン」
    const title = screen.getByText("タイムライン");
    expect(title.getBoundingClientRect().height).toBeLessThan(SINGLE_LINE_MAX);

    // スレッド表示トグル
    const threads = screen.getByText("スレッド");
    expect(threads.getBoundingClientRect().height).toBeLessThan(
      SINGLE_LINE_MAX,
    );

    // 件数「40 シーン」(JA ロケール)
    const count = screen.getByText(/40\s*シーン/);
    expect(count.getBoundingClientRect().height).toBeLessThan(SINGLE_LINE_MAX);
  });

  it("極端に狭い 240px でも縦割れしない (折り返しのみ)", () => {
    renderNarrow(240);

    for (const text of ["タイムライン", "スレッド"]) {
      const el = screen.getByText(text);
      expect(el.getBoundingClientRect().height).toBeLessThan(SINGLE_LINE_MAX);
    }
  });
});
