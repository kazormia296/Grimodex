import { describe, expect, it } from "vitest";
import {
  bottomDockPx,
  buildCenterStripeGridTemplateColumns,
  buildLayoutGridTemplateAreas,
  buildLayoutGridTemplateColumns,
  buildLayoutGridTemplateRows,
  computeLayoutGridMetrics,
  regionContentPx,
  sideDockPx,
  sideLayoutChromePx,
} from "./layoutMetrics";
import {
  LEGACY_SPLITTER_PX,
  SPLITTER_GUTTER_PX,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
} from "./layoutConstants";

describe("layoutMetrics", () => {
  it("regionContentPx returns 0 when closed", () => {
    expect(regionContentPx(false, 260)).toBe(0);
    expect(regionContentPx(true, 260)).toBe(260);
  });

  it("sideDockPx includes stripe and content when open", () => {
    expect(sideDockPx(true, true, 260)).toBe(STRIPE_SIZE + 260);
    expect(sideDockPx(true, false, 260)).toBe(STRIPE_SIZE);
    expect(sideDockPx(false, true, 260)).toBe(0);
  });

  it("bottomDockPx includes stripe, content, and the content↔stripe gap", () => {
    // もちもち ON: content↔icon-stripe 間の stripe-gap を含む。
    expect(bottomDockPx(true, true, 220)).toBe(
      STRIPE_SIZE + 220 + STRIPE_GAP_PX,
    );
    expect(bottomDockPx(true, false, 220)).toBe(STRIPE_SIZE);
    // もちもち OFF: ギャップなし。
    expect(bottomDockPx(true, true, 220, false)).toBe(STRIPE_SIZE + 220);
  });

  it("computeLayoutGridMetrics splits stripe, content, and splitter columns", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: true,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: true,
      centerBandVisible: true,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 220,
    });

    expect(m.leftStripePx).toBe(STRIPE_SIZE);
    expect(m.rightStripePx).toBe(STRIPE_SIZE);
    expect(m.leftContentPx).toBe(260);
    expect(m.rightContentPx).toBe(340);
    expect(m.leftSplitterPx).toBe(SPLITTER_GUTTER_PX);
    expect(m.rightSplitterPx).toBe(SPLITTER_GUTTER_PX);
    expect(m.leftDockPx).toBe(STRIPE_SIZE + 260);
    expect(m.rightDockPx).toBe(STRIPE_SIZE + 340);
    expect(m.bottomDockPx).toBe(STRIPE_SIZE + 220 + STRIPE_GAP_PX);
    expect(m.bottomCellPx).toBe(m.bottomDockPx + SPLITTER_GUTTER_PX);
  });

  it("buildLayoutGridTemplateColumns uses 1fr center when band visible", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: true,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: true,
      centerBandVisible: true,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 220,
    });

    expect(buildLayoutGridTemplateColumns(m)).toBe(
      `${STRIPE_SIZE}px ${STRIPE_GAP_PX}px 260px ${SPLITTER_GUTTER_PX}px minmax(0, 1fr) ${SPLITTER_GUTTER_PX}px 340px ${STRIPE_GAP_PX}px ${STRIPE_SIZE}px`,
    );
    expect(sideLayoutChromePx(m)).toBe(
      STRIPE_SIZE * 2 + 260 + 340 + SPLITTER_GUTTER_PX * 2 + STRIPE_GAP_PX * 2,
    );
  });

  it("omits gap tracks and uses thin splitters when mochi is off", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: true,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: true,
      centerBandVisible: true,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 220,
      mochi: false,
    });

    expect(m.gapLeftPx).toBe(0);
    expect(m.gapRightPx).toBe(0);
    expect(m.gapRowPx).toBe(0);
    expect(m.leftSplitterPx).toBe(LEGACY_SPLITTER_PX);
    expect(m.rightSplitterPx).toBe(LEGACY_SPLITTER_PX);
    expect(m.bottomCellPx).toBe(m.bottomDockPx + LEGACY_SPLITTER_PX);
    expect(buildLayoutGridTemplateColumns(m)).toBe(
      `${STRIPE_SIZE}px 0px 260px ${LEGACY_SPLITTER_PX}px minmax(0, 1fr) ${LEGACY_SPLITTER_PX}px 340px 0px ${STRIPE_SIZE}px`,
    );
    expect(buildLayoutGridTemplateRows(m, true)).toBe(
      `${STRIPE_SIZE}px 0px 1fr ${m.bottomCellPx}px`,
    );
  });

  it("buildLayoutGridTemplateColumns uses 0px center when band hidden", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: false,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 0,
    });

    expect(buildLayoutGridTemplateColumns(m)).toContain("0px");
  });

  it("makes the right region the 1fr filler when center band is hidden", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: false,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 0,
    });

    // 余白を吸収する右 region は 1fr。固定 px のままだとウィンドウ幅に
    // 追従できず右側に隙間が生じる。
    expect(m.fillerRegion).toBe("right");
    // filler の splitter は消し、resize 境界は左 splitter だけにする。
    expect(m.leftSplitterPx).toBe(SPLITTER_GUTTER_PX);
    expect(m.rightSplitterPx).toBe(0);
    expect(buildLayoutGridTemplateColumns(m)).toBe(
      `${STRIPE_SIZE}px ${STRIPE_GAP_PX}px 260px ${SPLITTER_GUTTER_PX}px 0px 0px minmax(0, 1fr) ${STRIPE_GAP_PX}px ${STRIPE_SIZE}px`,
    );
  });

  it("uses the left region as filler when only left is open and band hidden", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: false,
      leftOpen: true,
      rightOpen: false,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 0,
    });

    expect(m.fillerRegion).toBe("left");
    expect(m.leftSplitterPx).toBe(0);
    expect(buildLayoutGridTemplateColumns(m)).toContain("minmax(0, 1fr)");
  });

  it("computeLayoutGridMetrics omits content and splitter when region closed", () => {
    const m = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: true,
      leftOpen: false,
      rightOpen: false,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 220,
    });

    expect(m.leftContentPx).toBe(0);
    expect(m.rightContentPx).toBe(0);
    expect(m.leftSplitterPx).toBe(0);
    expect(m.rightSplitterPx).toBe(0);
    expect(m.leftStripePx).toBe(STRIPE_SIZE);
    expect(m.rightStripePx).toBe(STRIPE_SIZE);
    // content を閉じていても bottom stripe を浮かせる stripe-gap は残る。
    expect(m.bottomCellPx).toBe(STRIPE_SIZE + STRIPE_GAP_PX);

    // もちもち OFF: 閉じた bottom には gap を入れない（旧レイアウト）。
    const legacy = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: true,
      leftOpen: false,
      rightOpen: false,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 220,
      mochi: false,
    });
    expect(legacy.bottomCellPx).toBe(STRIPE_SIZE);
  });

  it("buildCenterStripeGridTemplateColumns mirrors the center band columns", () => {
    const metrics = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: false,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
      centerBandVisible: true,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 0,
    });
    expect(buildCenterStripeGridTemplateColumns(metrics)).toBe(
      `260px ${SPLITTER_GUTTER_PX}px minmax(0, 1fr) ${SPLITTER_GUTTER_PX}px 340px`,
    );
  });

  it("buildCenterStripeGridTemplateColumns keeps auto width for editor toggle when center band hidden", () => {
    const metrics = computeLayoutGridMetrics({
      hasLeft: true,
      hasRight: true,
      hasBottom: false,
      leftOpen: true,
      rightOpen: true,
      bottomOpen: false,
      centerBandVisible: false,
      leftSize: 260,
      rightSize: 340,
      bottomSize: 0,
    });
    expect(metrics.centerColumnPx).toBe("0px");
    expect(buildCenterStripeGridTemplateColumns(metrics)).toContain(" auto ");
  });

  describe("buildLayoutGridTemplateAreas", () => {
    it("extends both side regions into the bottom row by default", () => {
      const areas = buildLayoutGridTemplateAreas(true, {
        left: false,
        right: false,
      });
      expect(areas).toContain(
        '"lstripe . lcontent lspl bottom rspl rcontent . rstripe"',
      );
    });

    it("gives the bottom-left corner to the bottom region", () => {
      const areas = buildLayoutGridTemplateAreas(true, {
        left: true,
        right: false,
      });
      expect(areas).toContain(
        '"bottom bottom bottom bottom bottom rspl rcontent . rstripe"',
      );
    });

    it("gives the bottom-right corner to the bottom region", () => {
      const areas = buildLayoutGridTemplateAreas(true, {
        left: false,
        right: true,
      });
      expect(areas).toContain(
        '"lstripe . lcontent lspl bottom bottom bottom bottom bottom"',
      );
    });

    it("gives both corners to the bottom region", () => {
      const areas = buildLayoutGridTemplateAreas(true, {
        left: true,
        right: true,
      });
      expect(areas).toContain(
        '"bottom bottom bottom bottom bottom bottom bottom bottom bottom"',
      );
    });

    it("omits the bottom row entirely when there is no bottom region", () => {
      const areas = buildLayoutGridTemplateAreas(false, {
        left: true,
        right: true,
      });
      expect(areas).not.toContain("bottom");
    });
  });
});
