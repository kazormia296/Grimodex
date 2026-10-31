import { describe, expect, it } from "vitest";
import {
  bottomDockPx,
  buildCenterStripeGridTemplateColumns,
  buildLayoutGridTemplateAreas,
  buildLayoutGridTemplateColumns,
  buildZoomGridTemplateColumns,
  buildZoomGridTemplateRows,
  computeLayoutGridMetrics,
  OVERLAY_KNOB_LEAD_PX,
  overlayKnobExtraPx,
  regionContentPx,
  sideDockPx,
  sideLayoutChromePx,
} from "./layoutMetrics";
import {
  HORIZONTAL_STRIPE_SIZE,
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
    expect(bottomDockPx(true, true, 220)).toBe(
      HORIZONTAL_STRIPE_SIZE + 220 + STRIPE_GAP_PX,
    );
    expect(bottomDockPx(true, false, 220)).toBe(HORIZONTAL_STRIPE_SIZE);
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
    expect(m.bottomDockPx).toBe(HORIZONTAL_STRIPE_SIZE + 220 + STRIPE_GAP_PX);
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
    expect(m.bottomCellPx).toBe(HORIZONTAL_STRIPE_SIZE + STRIPE_GAP_PX);
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

  describe("overlay のつまみ（上段の角）", () => {
    const base = {
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
    };
    const both = { left: true, right: true };
    /** "36px 12px 260px ..." のような列の並びから px の列だけを足す（fr は 0）。 */
    const fixedPx = (columns: string) =>
      columns
        .split(" ")
        .filter((c) => /^\d+(\.\d+)?px$/.test(c))
        .reduce((sum, c) => sum + parseFloat(c), 0);

    it("OVERLAY_KNOB_LEAD_PX は stripe 1 列とギャップ 1 本", () => {
      expect(OVERLAY_KNOB_LEAD_PX).toBe(STRIPE_SIZE + STRIPE_GAP_PX);
      expect(overlayKnobExtraPx(true, false)).toBe(OVERLAY_KNOB_LEAD_PX);
      expect(overlayKnobExtraPx(true, true)).toBe(0);
      expect(overlayKnobExtraPx(false, false)).toBe(0);
    });

    it("region の内容が出ている側は、つまみがあっても列は増えない", () => {
      const plain = computeLayoutGridMetrics(base);
      const knobs = computeLayoutGridMetrics({ ...base, overlayKnobs: both });
      expect(knobs.leftKnob).toBe(true);
      expect(knobs.rightKnob).toBe(true);
      expect(knobs.gapLeftPx).toBe(plain.gapLeftPx);
      expect(knobs.gapRightPx).toBe(plain.gapRightPx);
      expect(knobs.leftStripePx).toBe(STRIPE_SIZE);
      expect(buildLayoutGridTemplateColumns(knobs)).toBe(
        buildLayoutGridTemplateColumns(plain),
      );
      expect(sideLayoutChromePx(knobs)).toBe(sideLayoutChromePx(plain));
    });

    it("region が閉じている側は、gap 列につまみとトグルの分 OVERLAY_KNOB_LEAD_PX を足す", () => {
      const closed = { ...base, leftOpen: false, rightOpen: false };
      const plain = computeLayoutGridMetrics(closed);
      const knobs = computeLayoutGridMetrics({ ...closed, overlayKnobs: both });
      expect(knobs.leftStripePx).toBe(STRIPE_SIZE);
      expect(knobs.gapLeftPx).toBe(STRIPE_GAP_PX + OVERLAY_KNOB_LEAD_PX);
      expect(knobs.gapRightPx).toBe(STRIPE_GAP_PX + OVERLAY_KNOB_LEAD_PX);
      expect(sideLayoutChromePx(knobs) - sideLayoutChromePx(plain)).toBe(
        OVERLAY_KNOB_LEAD_PX * 2,
      );
      // 片側だけ
      const leftOnly = computeLayoutGridMetrics({
        ...closed,
        overlayKnobs: { left: true, right: false },
      });
      expect(leftOnly.gapRightPx).toBe(plain.gapRightPx);
      expect(sideLayoutChromePx(leftOnly) - sideLayoutChromePx(plain)).toBe(
        OVERLAY_KNOB_LEAD_PX,
      );
    });

    it("パネルが無い側は、角のために stripe 列とギャップだけを取る", () => {
      const none = { ...base, hasLeft: false, hasRight: false };
      const plain = computeLayoutGridMetrics(none);
      const knobs = computeLayoutGridMetrics({ ...none, overlayKnobs: both });
      expect(plain.leftStripePx).toBe(0);
      expect(plain.gapLeftPx).toBe(0);
      expect(knobs.leftStripePx).toBe(STRIPE_SIZE);
      expect(knobs.rightStripePx).toBe(STRIPE_SIZE);
      expect(knobs.gapLeftPx).toBe(STRIPE_GAP_PX);
      expect(knobs.gapRightPx).toBe(STRIPE_GAP_PX);
      expect(sideLayoutChromePx(knobs) - sideLayoutChromePx(plain)).toBe(
        OVERLAY_KNOB_LEAD_PX * 2,
      );
    });

    it("store の差し引き（overlayKnobExtraPx）と grid の列の増分が一致する", () => {
      for (const hasSide of [true, false]) {
        for (const open of [true, false]) {
          const input = {
            ...base,
            hasLeft: hasSide,
            leftOpen: open,
            hasRight: false,
            rightOpen: false,
          };
          const plain = computeLayoutGridMetrics(input);
          const knobs = computeLayoutGridMetrics({
            ...input,
            overlayKnobs: { left: true, right: false },
          });
          expect(sideLayoutChromePx(knobs) - sideLayoutChromePx(plain)).toBe(
            overlayKnobExtraPx(true, hasSide && open),
          );
        }
      }
    });

    it("center stripe の列は、つまみのある側で stripe 列を落とし gap から余白を引く", () => {
      const open = computeLayoutGridMetrics({
        ...base,
        overlayKnobs: { left: true, right: false },
      });
      expect(buildCenterStripeGridTemplateColumns(open)).toBe(
        `0px 260px ${SPLITTER_GUTTER_PX}px minmax(0, 1fr) ${SPLITTER_GUTTER_PX}px 340px ${STRIPE_GAP_PX}px ${STRIPE_SIZE}px`,
      );
      const closed = computeLayoutGridMetrics({
        ...base,
        leftOpen: false,
        rightOpen: false,
        overlayKnobs: both,
      });
      expect(buildCenterStripeGridTemplateColumns(closed)).toBe(
        `${OVERLAY_KNOB_LEAD_PX}px 0px 0px minmax(0, 1fr) 0px 0px ${OVERLAY_KNOB_LEAD_PX}px`,
      );
    });

    it("center stripe の列幅 + 両側の角とギャップ = メイングリッドの列幅（bands が editor 列と揃う）", () => {
      for (const hasSide of [true, false]) {
        for (const open of [true, false]) {
          const metrics = computeLayoutGridMetrics({
            ...base,
            hasLeft: hasSide,
            hasRight: hasSide,
            leftOpen: open,
            rightOpen: open,
            overlayKnobs: both,
          });
          const stripeColumns = buildCenterStripeGridTemplateColumns(metrics);
          expect(
            fixedPx(stripeColumns) + (STRIPE_SIZE + STRIPE_GAP_PX) * 2,
          ).toBe(fixedPx(buildLayoutGridTemplateColumns(metrics)));
          // 左の editor 列までの距離も一致する（列の個数が違うので先頭の和で見る）。
          const lead = metrics.gapLeftPx - STRIPE_GAP_PX;
          expect(parseFloat(stripeColumns)).toBe(lead);
        }
      }
    });
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

    it("gives the top corner cell to the overlay knob on the sides that have one", () => {
      const row = (l: string, r: string) =>
        `"${l} cstripe cstripe cstripe cstripe cstripe cstripe cstripe ${r}"`;
      const none = { left: false, right: false };
      expect(buildLayoutGridTemplateAreas(false, none)).toContain(
        row("cstripe", "cstripe"),
      );
      expect(
        buildLayoutGridTemplateAreas(false, none, {
          left: true,
          right: false,
        }),
      ).toContain(row("lknob", "cstripe"));
      expect(
        buildLayoutGridTemplateAreas(false, none, {
          left: false,
          right: true,
        }),
      ).toContain(row("cstripe", "rknob"));
      const both = buildLayoutGridTemplateAreas(true, none, {
        left: true,
        right: true,
      });
      expect(both).toContain(row("lknob", "rknob"));
      // 角以外（gap 行・main 行）は変わらない。
      expect(both).toContain('". . . . . . . . ."');
      expect(both).toContain(
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
    it("keeps the restore-bar row and frees only the main row for non-bottom zoom", () => {
      expect(buildZoomGridTemplateRows("left", false, 0)).toBe(
        `${HORIZONTAL_STRIPE_SIZE}px 0px minmax(0, 1fr)`,
      );
      expect(buildZoomGridTemplateRows("center", true, STRIPE_GAP_PX)).toBe(
        `${HORIZONTAL_STRIPE_SIZE}px ${STRIPE_GAP_PX}px minmax(0, 1fr) 0px`,
      );
    });

    it("keeps the restore-bar row and frees only the bottom row for bottom zoom", () => {
      expect(buildZoomGridTemplateRows("bottom", true, STRIPE_GAP_PX)).toBe(
        `${HORIZONTAL_STRIPE_SIZE}px ${STRIPE_GAP_PX}px 0px minmax(0, 1fr)`,
      );
    });
  });
});
