// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { TrashBinPhysicsView } from "./TrashBinPhysicsView";
import type { TrashItemData } from "./types";

const FAKE_RECT = {
  width: 400,
  height: 600,
  top: 0,
  left: 0,
  right: 400,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

class StubResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [{ target } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];
  private cb: IntersectionObserverCallback;
  private targets: Element[] = [];
  root: Element | null = null;
  rootMargin = "";
  thresholds: ReadonlyArray<number> = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    StubIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
    this.fire(true);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 外部から可視性を切り替えるためのテスト用ヘルパ。 */
  fire(isIntersecting: boolean) {
    this.cb(
      this.targets.map(
        (target) =>
          ({ target, isIntersecting }) as unknown as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

let rafCallbacks: Array<(t: number) => void> = [];
let rafTime = 0;
let rafId = 0;

function flushRaf(steps: number, dtMs = 16) {
  for (let i = 0; i < steps; i++) {
    rafTime += dtMs;
    const cbs = rafCallbacks;
    rafCallbacks = [];
    for (const cb of cbs) cb(rafTime);
  }
}

function makeFakeItem(
  id: string,
  overrides: Partial<TrashItemData> = {},
): TrashItemData {
  return {
    id,
    projectId: "p",
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText: id,
    previewMeta: null,
    payload: { text: id, spans: [] },
    charCount: id.length,
    isInteresting: false,
    deletedAt: new Date(2026, 0, 1).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  rafCallbacks = [];
  rafTime = 0;
  rafId = 0;
  StubIntersectionObserver.instances = [];
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => {
    rafCallbacks.push(cb);
    rafId += 1;
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);
  Element.prototype.getBoundingClientRect = vi.fn(() => FAKE_RECT);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function getNode(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[title="${id}"]`);
}

function parseTransform(
  transform: string,
): { x: number; y: number; rot: number } | null {
  const m = transform.match(
    /translate3d\(([-0-9.]+)px,\s*([-0-9.]+)px,\s*0\)\s*rotate\(([-0-9.]+)deg\)/,
  );
  if (!m) return null;
  return {
    x: parseFloat(m[1]),
    y: parseFloat(m[2]),
    rot: parseFloat(m[3]),
  };
}

describe("TrashBinPhysicsView", () => {
  it("初回ロード: 既存アイテムは床積み (settled=true) で配置される", () => {
    const items = [makeFakeItem("a"), makeFakeItem("b")];
    const { container } = render(
      <TrashBinPhysicsView items={items} isLoading={false} />,
    );
    const nodes = container.querySelectorAll<HTMLElement>("[data-subkind]");
    expect(nodes.length).toBe(2);
    for (const node of nodes) {
      expect(node.dataset.settled).toBe("true");
      const t = parseTransform(node.style.transform);
      expect(t).not.toBeNull();
      // settled body はコンテナの底面付近にいる
      expect(t!.y).toBeGreaterThan(0);
      expect(t!.y).toBeLessThanOrEqual(FAKE_RECT.height);
    }
    // 初期 batch は rAF を起動しない (全員 settled なので)
    expect(rafCallbacks.length).toBe(0);
  });

  it("初回ロード後の追加アイテムは y=-h から落下 (settled=false)", () => {
    const initial = [makeFakeItem("a"), makeFakeItem("b")];
    const { rerender, container } = render(
      <TrashBinPhysicsView items={initial} isLoading={false} />,
    );
    rerender(
      <TrashBinPhysicsView
        items={[...initial, makeFakeItem("c")]}
        isLoading={false}
      />,
    );
    const c = getNode(container, "c");
    expect(c).not.toBeNull();
    expect(c!.dataset.settled).toBe("false");
    const t = parseTransform(c!.style.transform);
    expect(t).not.toBeNull();
    expect(t!.y).toBeLessThan(0); // 上から落下開始
    // 落下する body がいるので rAF が起動している
    expect(rafCallbacks.length).toBeGreaterThan(0);
  });

  it("rAF を進めると追加 body が settle する", () => {
    const initial = [makeFakeItem("a"), makeFakeItem("b")];
    const { rerender, container } = render(
      <TrashBinPhysicsView items={initial} isLoading={false} />,
    );
    rerender(
      <TrashBinPhysicsView
        items={[...initial, makeFakeItem("c")]}
        isLoading={false}
      />,
    );
    // rAF が止まる（=全 body が settle した）まで進める。安全のため 2000 フレーム上限。
    let frame = 0;
    while (rafCallbacks.length > 0 && frame < 2000) {
      flushRaf(1);
      frame += 1;
    }
    const c = getNode(container, "c");
    expect(c).not.toBeNull();
    expect(c!.dataset.settled).toBe("true");
    const t = parseTransform(c!.style.transform);
    expect(t).not.toBeNull();
    // settled body は床面付近 (height は size 計算で 28、container 高さ 600)
    expect(t!.y).toBeGreaterThan(FAKE_RECT.height - 100);
    // settle 後は rAF が止まる
    expect(rafCallbacks.length).toBe(0);
  });

  it("削除されたアイテムは DOM からも消える", () => {
    const initial = [makeFakeItem("a"), makeFakeItem("b")];
    const { rerender, container } = render(
      <TrashBinPhysicsView items={initial} isLoading={false} />,
    );
    expect(getNode(container, "a")).not.toBeNull();
    expect(getNode(container, "b")).not.toBeNull();
    rerender(
      <TrashBinPhysicsView items={[makeFakeItem("a")]} isLoading={false} />,
    );
    expect(getNode(container, "a")).not.toBeNull();
    expect(getNode(container, "b")).toBeNull();
  });

  it("isLoading=true は本体を描画せず loading 表示のみ", () => {
    const { container } = render(
      <TrashBinPhysicsView items={[]} isLoading={true} />,
    );
    expect(container.querySelector("[data-subkind]")).toBeNull();
    expect(container.textContent ?? "").toContain("…");
  });

  it("可視性 false で rAF が次フレーム以降スケジュールされない", () => {
    const initial = [makeFakeItem("a"), makeFakeItem("b")];
    const { rerender } = render(
      <TrashBinPhysicsView items={initial} isLoading={false} />,
    );
    rerender(
      <TrashBinPhysicsView
        items={[...initial, makeFakeItem("c")]}
        isLoading={false}
      />,
    );
    expect(rafCallbacks.length).toBeGreaterThan(0); // 落下中
    // パネル非表示にする
    StubIntersectionObserver.instances.forEach((io) => io.fire(false));
    // 次フレームを進めると、tick が visibleRef=false を見て reschedule しない
    flushRaf(1);
    expect(rafCallbacks.length).toBe(0);
    // さらに進めても再開しない
    flushRaf(10);
    expect(rafCallbacks.length).toBe(0);
  });

  it("空アイテム時は empty メッセージが表示される", () => {
    const { container } = render(
      <TrashBinPhysicsView items={[]} isLoading={false} />,
    );
    expect(container.querySelector("[data-subkind]")).toBeNull();
    // i18n キー or 翻訳済テキストのいずれか
    expect(container.textContent ?? "").not.toBe("");
  });
});
