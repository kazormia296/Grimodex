import { describe, expect, it } from "vitest";
import {
  bottomDockPx,
  buildCenterStripeGridTemplateColumns,
  buildLayoutGridTemplateAreas,
  buildLayoutGridTemplateColumns,
  buildLayoutGridTemplateRows,
  buildZoomGridTemplateColumns,
  buildZoomGridTemplateRows,
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
    // カードレイアウト ON: content↔icon-stripe 間の stripe-gap を含む。
    expect(bottomDockPx(true, true, 220)).toBe(
      STRIPE_SIZE + 220 + STRIPE_GAP_PX,
    );
    expect(bottomDockPx(true, false, 220)).toBe(STRIPE_SIZE);
    // カードレイアウト OFF: ギャップなし。
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

  it("omits gap tracks and uses thin splitters when cardLayout is off", () => {
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
      cardLayout: false,
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

    // カードレイアウト OFF: 閉じた bottom には gap を入れない（旧レイアウト）。
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
      cardLayout: false,
    });
    expect(legacy.bottomCellPx).toBe(STRIPE_SIZE);
  });

  it("buildCenterStripeGridTemplateColumns spans the full 9-column grid", () => {
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
    // center stripe は全幅。stripe / gap 列を含む 9 列で bands を editor と揃える。
    expect(buildCenterStripeGridTemplateColumns(metrics)).toBe(
      `${STRIPE_SIZE}px ${STRIPE_GAP_PX}px 260px ${SPLITTER_GUTTER_PX}px minmax(0, 1fr) ${SPLITTER_GUTTER_PX}px 340px ${STRIPE_GAP_PX}px ${STRIPE_SIZE}px`,
    );
  });

  it("buildCenterStripeGridTemplateColumns matches the main grid columns when the center band is visible", () => {
    const metrics = computeLayoutGridMetrics({
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
    // 中央列が実寸のとき center stripe の 9 列はメイングリッドと完全一致し、
    // bands が下の editor 列とピクセル単位で揃う。
    expect(buildCenterStripeGridTemplateColumns(metrics)).toBe(
      buildLayoutGridTemplateColumns(metrics),
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
    it("spans the center stripe full-width and starts side stripes at the main row", () => {
      const areas = buildLayoutGridTemplateAreas(false, {
        left: false,
        right: false,
      });
      // 上段は center stripe が全 9 列を占有し、上の両角も持つ。
      expect(areas).toContain(
        '"cstripe cstripe cstripe cstripe cstripe cstripe cstripe cstripe cstripe"',
      );
      // gap 行に side stripe は無い（main 行から始まり content と上端が揃う）。
      expect(areas).toContain('". . . . . . . . ."');
      expect(areas).toContain(
        '"lstripe . lcontent lspl editor rspl rcontent . rstripe"',
      );
    });

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

  describe("buildZoomGridTemplateColumns", () => {
    it("keeps the 9-column shape and frees only the target content column", () => {
      expect(buildZoomGridTemplateColumns("left")).toBe(
        "0px 0px minmax(0, 1fr) 0px 0px 0px 0px 0px 0px",
      );
      expect(buildZoomGridTemplateColumns("right")).toBe(
        "0px 0px 0px 0px 0px 0px minmax(0, 1fr) 0px 0px",
      );
      expect(buildZoomGridTemplateColumns("center")).toBe(
        "0px 0px 0px 0px minmax(0, 1fr) 0px 0px 0px 0px",
      );
      // bottom は bottom 行が areas 側で全幅化されるため中央列に 1fr を置く。
      expect(buildZoomGridTemplateColumns("bottom")).toBe(
        "0px 0px 0px 0px minmax(0, 1fr) 0px 0px 0px 0px",
      );
    });
  });

  describe("buildZoomGridTemplateRows", () => {
    it("frees only the main row for non-bottom zoom", () => {
      expect(buildZoomGridTemplateRows("left", false)).toBe(
        "0px 0px minmax(0, 1fr)",
      );
      expect(buildZoomGridTemplateRows("center", true)).toBe(
        "0px 0px minmax(0, 1fr) 0px",
      );
    });

    it("frees only the bottom row for bottom zoom", () => {
      expect(buildZoomGridTemplateRows("bottom", true)).toBe(
        "0px 0px 0px minmax(0, 1fr)",
      );
    });
  });
});
