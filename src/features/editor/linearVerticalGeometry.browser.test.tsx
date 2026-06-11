/**
 * LinearEditorView の縦書きスクロール幾何を実 Chromium で gate する。
 *
 * LinearEditorView 本体は store 依存が深く、browser mode の
 * 「vi.mock は graph 内全 named export 網羅必須」規約の再発点になるため
 * mount しない。代わりに、本体が依存している契約そのものを素の DOM +
 * editorLayout 純関数で検証する:
 * - pickActiveSceneId が実レイアウトの rect で正しい active を選ぶ
 * - scrollIntoView({block:'start'}) が vertical-rl コンテナで論理解決される
 *   （右端整列 + scrollLeft 負方向）— L241/255 を無改修にしている根拠
 * - ResizeObserver contentBoxSize[0].blockSize が縦書きで物理 width を返す
 *   — LinearSceneBlock の placeholder 計測置き換えの根拠
 * - .editor-scene-separator の border-block-start の軸マップ
 */
import { describe, it, expect } from "vitest";
import {
  getLogicalScrollOffset,
  pickActiveSceneId,
  setLogicalScrollOffset,
} from "./editorLayout";

function buildLinearFixture(vertical: boolean): {
  container: HTMLElement;
  blocks: HTMLElement[];
} {
  const container = document.createElement("div");
  container.className = vertical ? "editor-vertical" : "";
  container.style.cssText = "width: 400px; height: 400px; overflow: auto;";
  const blocks: HTMLElement[] = [];
  for (let i = 0; i < 5; i++) {
    const block = document.createElement("div");
    block.dataset.sceneId = `scene-${i}`;
    // ブロック軸方向に 300px（横=高さ / 縦=幅）
    block.style.blockSize = "300px";
    block.textContent = `scene ${i}`;
    container.appendChild(block);
    blocks.push(block);
  }
  document.body.appendChild(container);
  return { container, blocks };
}

describe("Linear 縦書き幾何: pickActiveSceneId", () => {
  it.each([false, true])(
    "vertical=%s: スクロール後に block-start に最も近いシーンを選ぶ",
    (vertical) => {
      const { container } = buildLinearFixture(vertical);
      try {
        // scene-1 の先頭 (offset 300) + 少し (40px) まで進める
        setLogicalScrollOffset(container, 340, vertical);
        expect(getLogicalScrollOffset(container, vertical)).toBe(340);
        const containerRect = container.getBoundingClientRect();
        const items = Array.from(
          container.querySelectorAll("[data-scene-id]"),
        ).map((el) => ({
          id: (el as HTMLElement).dataset.sceneId ?? "",
          rect: el.getBoundingClientRect(),
        }));
        // scene-1 の block-start は -40、scene-2 は +260 → scene-1 が最近
        expect(pickActiveSceneId(containerRect, items, vertical)).toBe(
          "scene-1",
        );
      } finally {
        container.remove();
      }
    },
  );
});

describe("Linear 縦書き幾何: scrollIntoView の論理解決", () => {
  it("vertical-rl コンテナで block:'start' が右端整列・scrollLeft 負方向になる", () => {
    const { container, blocks } = buildLinearFixture(true);
    try {
      blocks[2].scrollIntoView({ block: "start" });
      // 進行方向 = 左 = scrollLeft 負（無反応なら 0 のままで検知される）
      expect(container.scrollLeft).toBeLessThan(0);
      // block-start = コンテナ右端に target の右端が揃う
      const containerRect = container.getBoundingClientRect();
      const targetRect = blocks[2].getBoundingClientRect();
      expect(Math.abs(containerRect.right - targetRect.right)).toBeLessThan(2);
    } finally {
      container.remove();
    }
  });

  it("横書きでは従来どおり上端整列（回帰）", () => {
    const { container, blocks } = buildLinearFixture(false);
    try {
      blocks[2].scrollIntoView({ block: "start" });
      expect(container.scrollTop).toBeGreaterThan(0);
      const containerRect = container.getBoundingClientRect();
      const targetRect = blocks[2].getBoundingClientRect();
      expect(Math.abs(targetRect.top - containerRect.top)).toBeLessThan(2);
    } finally {
      container.remove();
    }
  });
});

describe("Linear 縦書き幾何: ResizeObserver の論理計測", () => {
  it("contentBoxSize[0].blockSize が縦書きコンテナ内で物理 width を返す", async () => {
    const container = document.createElement("div");
    container.className = "editor-vertical";
    container.style.cssText = "width: 400px; height: 400px; overflow: auto;";
    const block = document.createElement("div");
    block.style.cssText = "width: 250px; height: 120px;";
    container.appendChild(block);
    document.body.appendChild(container);
    try {
      const measured = await new Promise<number>((resolve) => {
        const observer = new ResizeObserver((entries) => {
          const size = entries[0].contentBoxSize?.[0];
          resolve(size ? size.blockSize : -1);
          observer.disconnect();
        });
        observer.observe(block);
      });
      // 縦書きの block 軸 = 物理 width
      expect(measured).toBe(250);
    } finally {
      container.remove();
    }
  });
});

describe("Linear 縦書き幾何: シーン区切り線の軸", () => {
  it("border-block-start が横=上線 / 縦=右線に解決される", () => {
    const host = document.createElement("div");
    host.innerHTML = `
      <div><div class="editor-scene-separator" data-testid="sep-h"></div></div>
      <div class="editor-vertical" style="width:200px;height:200px">
        <div class="editor-scene-separator" data-testid="sep-v"></div>
      </div>`;
    document.body.appendChild(host);
    try {
      const h = host.querySelector("[data-testid='sep-h']") as HTMLElement;
      const v = host.querySelector("[data-testid='sep-v']") as HTMLElement;
      expect(getComputedStyle(h).borderTopWidth).toBe("1px");
      expect(getComputedStyle(h).borderRightWidth).toBe("0px");
      expect(getComputedStyle(v).borderRightWidth).toBe("1px");
      expect(getComputedStyle(v).borderTopWidth).toBe("0px");
      // margin-block も軸が変わる（横=上下 / 縦=左右）
      expect(getComputedStyle(h).marginTop).toBe("24px");
      expect(getComputedStyle(v).marginRight).toBe("24px");
    } finally {
      host.remove();
    }
  });
});
