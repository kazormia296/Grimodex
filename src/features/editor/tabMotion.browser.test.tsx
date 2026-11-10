/**
 * 実 Chromium で、エディタのタブの動きを gate する。
 *
 * - アクティブの下線はグループに 1 本で、前のタブの位置から滑る。
 * - ドロップ位置の線はタブに重ね、タブの中身を動かさない。
 * - 並べ替えの後、動いたタブは旧位置から滑る（スクロールしていてもずれない）。
 * - 動きを減らす設定では、どれも最終の状態をすぐに出す。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { page } from "vitest/browser";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTabStore, type TabEntry } from "./tabStore";

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: vi.fn(async () => ({})),
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
  isTauri: () => false,
}));

import { DRAG_DATA_KEY, TabBar } from "./TabBar";

const LABELS = ["第一章 雨の駅", "第二章", "第三章 港", "第四章"];

function tabEntries(count = LABELS.length): TabEntry[] {
  return LABELS.slice(0, count).map((label, index) => ({
    nodeId: `t${index}`,
    isPreview: false,
    contentType: "chronicle_event",
    label,
  }));
}

function setTabs(tabs: TabEntry[], activeTabId: string) {
  useTabStore.setState({ tabs, activeTabId, activeGroupIndex: 0 });
}

function setReduceMotion(on: boolean) {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "display.reduceMotion": on ? "true" : "false" },
  }));
}

function renderBar(width = 900) {
  return render(
    <div style={{ width }}>
      <TabBar groupIndex={0} />
    </div>,
  );
}

/**
 * mount の直後は motion がまだ各要素の位置を測り終えていない（数フレーム
 * かかる）。実際の操作は mount の直後には来ないので、十分に待ってから操作する。
 */
async function settleMount(): Promise<void> {
  for (let i = 0; i < 20; i++) await settleFrames();
}

function settleFrames(): Promise<void> {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );
}

function tab(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-editor-tab-id="${id}"]`)!;
}

function indicator(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    "[data-editor-tab-active-indicator]",
  );
}

function dragEvent(type: string, target: HTMLElement, payload: object) {
  const dataTransfer = new DataTransfer();
  dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
  const rect = target.getBoundingClientRect();
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    dataTransfer,
    clientX: rect.right - 2,
    clientY: rect.top + rect.height / 2,
  });
}

function flipRunning(el: HTMLElement): boolean {
  return el
    .getAnimations()
    .some((a) => a.id === "editor-tab-flip" && a.playState === "running");
}

beforeEach(async () => {
  await page.viewport(1200, 600);
  setReduceMotion(false);
});

describe("editor tab motion (real Chromium)", () => {
  it("slides the single active underline from the previous tab", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    const from = indicator(container)!.getBoundingClientRect();
    const target = tab(container, "t2").getBoundingClientRect();
    expect(
      Math.abs(from.left - tab(container, "t0").getBoundingClientRect().left),
    ).toBeLessThan(1);

    act(() => {
      useTabStore.setState({ activeTabId: "t2" });
    });
    await settleFrames();

    // 下線は 1 本だけで、途中（前のタブと新しいタブの間）にいる。
    expect(
      container.querySelectorAll("[data-editor-tab-active-indicator]"),
    ).toHaveLength(1);
    const mid = indicator(container)!.getBoundingClientRect();
    expect(mid.left).toBeGreaterThan(from.left + 1);
    expect(mid.left).toBeLessThan(target.left - 1);

    // 新しいタブの下に着き、transform を残さない（アクティブは太字になり、
    // 幅が少し変わるので、着いた後のタブの矩形と比べる）。
    await waitFor(() => {
      const r = indicator(container)!.getBoundingClientRect();
      const now = tab(container, "t2").getBoundingClientRect();
      expect(Math.abs(r.left - now.left)).toBeLessThan(0.5);
      // 下線は右の枠線（1px）の内側に収まる（以前の after: の下線と同じ）。
      expect(Math.abs(r.width - (now.width - 1))).toBeLessThan(0.5);
    });
    await waitFor(() => {
      expect(getComputedStyle(indicator(container)!).transform).toBe("none");
    });
  });

  it("does not clip the travelling underline by the new tab's box", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    // 開いているタブの外側は中身を切らない（切ると下線が端から伸びて見える）。
    const wrapper = tab(container, "t2").parentElement!;
    expect(getComputedStyle(wrapper).overflow).toBe("visible");
  });

  it("shows the drop line over the tab without shifting the tab's content", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    const target = tab(container, "t1");
    const title = target.querySelector("span.truncate")!;
    const before = title.getBoundingClientRect();
    const tabBefore = target.getBoundingClientRect();

    act(() => {
      target.dispatchEvent(
        dragEvent("dragover", target, { nodeId: "t3", groupIndex: 0 }),
      );
    });
    await settleFrames();

    const line = container.querySelector<HTMLElement>(
      '[data-tab-drop-indicator="right"]',
    );
    expect(line).not.toBeNull();
    const after = title.getBoundingClientRect();
    expect(after.left).toBe(before.left);
    expect(target.getBoundingClientRect().width).toBe(tabBefore.width);
    // 線は落とす側の辺に重なる。
    const lineRect = line!.getBoundingClientRect();
    expect(Math.abs(lineRect.right - tabBefore.right)).toBeLessThan(0.5);
  });

  it("slides moved tabs from their old positions after a reorder drop", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    const oldLeft = tab(container, "t0").getBoundingClientRect().left;
    const target = tab(container, "t2");

    // t0 を t2 の右へ落とす。
    act(() => {
      target.dispatchEvent(
        dragEvent("drop", target, { nodeId: "t0", groupIndex: 0 }),
      );
    });

    expect(useTabStore.getState().tabs.map((t) => t.nodeId)).toEqual([
      "t1",
      "t2",
      "t0",
      "t3",
    ]);
    const moved = tab(container, "t0");
    expect(flipRunning(moved)).toBe(true);
    // 見えている位置は旧位置から始まる。
    expect(Math.abs(moved.getBoundingClientRect().left - oldLeft)).toBeLessThan(
      2,
    );
    // 押し出された t1 も滑る。
    expect(flipRunning(tab(container, "t1"))).toBe(true);
    await waitFor(() => {
      expect(flipRunning(moved)).toBe(false);
    });
    expect(getComputedStyle(moved).transform).toBe("none");
  });

  it("keeps the reorder slide aligned while the tab row is scrolled", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar(260);
    await settleMount();
    const scroller = tab(container, "t0").closest<HTMLElement>(
      ".overflow-x-auto",
    )!;
    scroller.scrollLeft = 80;
    await settleFrames();
    const target = tab(container, "t1");
    const oldLeft = tab(container, "t2").getBoundingClientRect().left;

    act(() => {
      target.dispatchEvent(
        dragEvent("drop", target, { nodeId: "t2", groupIndex: 0 }),
      );
    });
    // 落とした直後に scrollLeft が変わっても、見えている位置から滑る。
    const moved = tab(container, "t2");
    expect(Math.abs(moved.getBoundingClientRect().left - oldLeft)).toBeLessThan(
      2,
    );
  });

  it("does not measure or slide on ordinary re-renders", async () => {
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    act(() => {
      // 並び以外の変化（ラベルの変更）。
      useTabStore.setState({
        tabs: tabEntries().map((t) =>
          t.nodeId === "t1" ? { ...t, label: "第二章（改）" } : t,
        ),
      });
    });
    for (const id of ["t0", "t1", "t2", "t3"]) {
      expect(flipRunning(tab(container, id))).toBe(false);
    }
  });

  it("puts everything at its final state at once when motion is reduced", async () => {
    setReduceMotion(true);
    setTabs(tabEntries(), "t0");
    const { container } = renderBar();
    await settleMount();
    const target = tab(container, "t2");

    act(() => {
      useTabStore.setState({ activeTabId: "t2" });
    });
    await settleFrames();
    const r = indicator(container)!.getBoundingClientRect();
    expect(Math.abs(r.left - target.getBoundingClientRect().left)).toBeLessThan(
      0.5,
    );

    act(() => {
      target.dispatchEvent(
        dragEvent("drop", target, { nodeId: "t0", groupIndex: 0 }),
      );
    });
    expect(flipRunning(tab(container, "t0"))).toBe(false);
  });
});
