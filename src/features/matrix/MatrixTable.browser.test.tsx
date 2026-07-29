/**
 * 実 Chromium で動かす Matrix の列ヘッダー横スクロール同期テスト。
 *
 * gate 対象 (4d947fbe "列ヘッダーを横スクロールに追従させ"): body を横スクロール
 * すると、別コンテナ(overflowX:hidden の headerRef)に居る列ヘッダーが scroll
 * リスナ (MatrixTable.tsx:105-113) 経由で body.scrollLeft を mirror し、列ヘッダー
 * セルが body セルと x 整列を保つ — という invariant。happy-dom は flex/overflow の
 * 実寸も scroll extent も計算せず、virtualizer も空配列を返すため単体では検証不能。
 * 差分検証済み: sync リスナを潰すと 2 本目(追従)が落ちる。
 *
 * 重要: test-setup-browser.ts は @tanstack/react-virtual を global mock している
 * (全 item レンダ・windowing 無効)。それだと「実 virtualizer が実 scroll element を
 * 測って windowing する」部分が coverage theater になるため、このファイルだけ
 * 実物で上書きする。windowing assertion (rendered < 全列) がその番人を兼ねる。
 */
import { vi } from "vitest";
// test-setup-browser.ts の global mock を、このファイルだけ実物で上書きする
// （browser mode では vi.unmock が mocker registry と競合するため importOriginal 経由）。
vi.mock(
  "@tanstack/react-virtual",
  async (importOriginal) => await importOriginal(),
);

import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { MatrixTable } from "./MatrixTable";
import { useMatrixStore } from "./matrixStore";
import type { MatrixRow } from "./lib/deriveRows";
import type { MatrixColumnOrHeader } from "./lib/deriveColumns";
import type { CellInfo } from "./lib/deriveCells";

const COLS = 30; // COL_WIDTH=80 → 全幅 2400px、host 600px で横溢れ
const columns = Array.from({ length: COLS }, (_, i) => ({
  key: `c${i}`,
  entry: { id: `e${i}`, name: `列${i}`, type: "character" },
  isSectionHeader: false,
})) as unknown as MatrixColumnOrHeader[];

const rows = Array.from({ length: 3 }, (_, i) => ({
  node: {
    id: `s${i}`,
    title: `シーン${i}`,
    povCharacterId: null,
    locationId: null,
  },
  depth: 0,
  isFolder: false,
})) as unknown as MatrixRow[];

const cellMap = new Map<string, CellInfo>();
const beatPovCache = new Set<string>();
const noop = () => {};
const asyncNoop = async () => {};

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
// virtualizer の計測 state 更新を act 内で flush（act 警告回避 + 再レンダ反映）
const settle = async () => {
  await act(async () => {
    await raf();
    await raf();
  });
};

function renderMatrix() {
  return render(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: 600,
        height: 400,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <MatrixTable
        rows={rows}
        columns={columns}
        cellMap={cellMap}
        beatPovCache={beatPovCache}
        displayMode="dot"
        showMode="codex-characters"
        onOpenScene={noop}
        onPin={asyncNoop}
        onRemovePin={asyncNoop}
        onAddBeat={asyncNoop}
        onAddScene={asyncNoop}
        onRenameNode={noop}
        onRevealInScenes={noop}
        onRevealInGrid={noop}
      />
    </div>,
  );
}

function renderMatrixInWorkspace(
  backgroundEnabled: boolean,
  glassEnabled: boolean,
) {
  return render(
    <div
      className="app-shell"
      style={{
        position: "fixed",
        inset: 0,
        width: 600,
        height: 400,
      }}
    >
      <main id="main-content" style={{ width: "100%", height: "100%" }}>
        <div
          data-editor-ambient
          data-background-enabled={backgroundEnabled ? "true" : "false"}
        />
        <div
          data-workspace-glass-root
          data-workspace-fluid-glass={glassEnabled ? "true" : "false"}
          style={{ width: "100%", height: "100%" }}
        >
          <section
            data-ambient-glass-surface="panel"
            className="gx-panel"
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <MatrixTable
              rows={rows}
              columns={columns}
              cellMap={cellMap}
              beatPovCache={beatPovCache}
              displayMode="dot"
              showMode="codex-characters"
              onOpenScene={noop}
              onPin={asyncNoop}
              onRemovePin={asyncNoop}
              onAddBeat={asyncNoop}
              onAddScene={asyncNoop}
              onRenameNode={noop}
              onRevealInScenes={noop}
              onRevealInGrid={noop}
            />
          </section>
        </div>
      </main>
    </div>,
  );
}

function computedBackgroundAlpha(element: HTMLElement): number {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas is unavailable");
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = getComputedStyle(element).backgroundColor;
  context.fillRect(0, 0, 1, 1);
  return context.getImageData(0, 0, 1, 1).data[3] / 255;
}

const left = (el: Element) => el.getBoundingClientRect().left;

beforeEach(() => {
  useMatrixStore.setState({
    collapsedRowIds: new Set<string>(),
    pinnedColumnIds: [],
    collapsedTypeSections: [],
    activeCustomSetId: null,
  });
});

describe("MatrixTable 列ヘッダー横スクロール同期 (real Chromium)", () => {
  it("実 virtualizer が windowing し、スクロール前は header/body セルが x 整列", async () => {
    const { container } = renderMatrix();
    await settle();

    // 実 virtualizer の番人: mock(全レンダ)なら 30 個出て落ちる
    const heads = container.querySelectorAll('[data-testid^="mx-colhead-"]');
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.length).toBeLessThan(COLS);

    const body = container.querySelector<HTMLElement>(
      '[data-testid="mx-body"]',
    )!;
    const header = container.querySelector<HTMLElement>(
      '[data-testid="mx-header"]',
    )!;
    expect(body.scrollLeft).toBe(0);
    expect(header.scrollLeft).toBe(0);

    // 同一列(index 5)の header セルと body セルが x 整列
    const head5 = container.querySelector('[data-testid="mx-colhead-5"]')!;
    const cell5 = container.querySelector('[data-testid="mx-cell-0-5"]')!;
    expect(Math.abs(left(head5) - left(cell5))).toBeLessThanOrEqual(1);
  });

  it("body を横スクロールすると列ヘッダーが追従し x 整列を保つ", async () => {
    const { container } = renderMatrix();
    await settle();

    const body = container.querySelector<HTMLElement>(
      '[data-testid="mx-body"]',
    )!;
    const header = container.querySelector<HTMLElement>(
      '[data-testid="mx-header"]',
    )!;

    // body を 160px 横スクロール → scroll リスナで header が mirror するはず
    await act(async () => {
      body.scrollLeft = 160;
      body.dispatchEvent(new Event("scroll"));
      await raf();
      await raf();
    });

    // sync 本体 (4d947fbe の gate): header が body の scrollLeft を mirror
    expect(header.scrollLeft).toBe(160);

    // スクロール後も同一列の header/body セルが x 整列 (col 5 は依然レンダ範囲内)
    const head5 = container.querySelector('[data-testid="mx-colhead-5"]')!;
    const cell5 = container.querySelector('[data-testid="mx-cell-0-5"]')!;
    expect(head5).toBeTruthy();
    expect(cell5).toBeTruthy();
    expect(Math.abs(left(head5) - left(cell5))).toBeLessThanOrEqual(1);
  });

  it("Glass 時だけ sticky ヘッダーと行ラベルを frosted fill にする", async () => {
    const { container } = renderMatrixInWorkspace(true, true);
    await settle();

    const host = container.querySelector<HTMLElement>(
      '[data-ambient-glass-surface="panel"]',
    )!;
    const columnHeader = container.querySelector<HTMLElement>(
      '[data-matrix-sticky-surface="column-header"]',
    )!;
    const rowHeader = container.querySelector<HTMLElement>(
      '[data-matrix-sticky-surface="row-header"]',
    )!;

    expect(columnHeader).toBeTruthy();
    expect(rowHeader).toBeTruthy();
    expect(computedBackgroundAlpha(columnHeader)).toBeCloseTo(0.7, 1);
    expect(computedBackgroundAlpha(rowHeader)).toBeCloseTo(0.7, 1);
    expect(getComputedStyle(columnHeader).backdropFilter).toBe("none");
    expect(getComputedStyle(rowHeader).backdropFilter).toBe("none");
    expect(getComputedStyle(host).backdropFilter).toContain("blur(14px)");

    const body = container.querySelector<HTMLElement>(
      '[data-testid="mx-body"]',
    )!;
    const stickyLeft = left(rowHeader);
    await act(async () => {
      body.scrollLeft = 160;
      body.dispatchEvent(new Event("scroll"));
      await raf();
      await raf();
    });
    expect(Math.abs(left(rowHeader) - stickyLeft)).toBeLessThanOrEqual(1);
  });

  it.each([
    { backgroundEnabled: false, glassEnabled: true },
    { backgroundEnabled: true, glassEnabled: false },
  ])(
    "背景または Glass が無効なら sticky 面を不透明に戻す ($backgroundEnabled/$glassEnabled)",
    async ({ backgroundEnabled, glassEnabled }) => {
      const { container } = renderMatrixInWorkspace(
        backgroundEnabled,
        glassEnabled,
      );
      await settle();

      const columnHeader = container.querySelector<HTMLElement>(
        '[data-matrix-sticky-surface="column-header"]',
      )!;
      const rowHeader = container.querySelector<HTMLElement>(
        '[data-matrix-sticky-surface="row-header"]',
      )!;

      expect(computedBackgroundAlpha(columnHeader)).toBe(1);
      expect(computedBackgroundAlpha(rowHeader)).toBe(1);
    },
  );
});
