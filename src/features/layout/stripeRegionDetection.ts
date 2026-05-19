import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
import type { PanelId } from "./layoutStore";
import type { StripeRegion, ToolWindowSlot } from "./toolWindowDefaults";

interface SimpleRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Panel group の矩形が editor group の矩形に対してどちら側かを判定する純粋関数。
 *
 * 判定ルール:
 * - `panel.top ≥ editor.bottom` **かつ** editor と水平方向に重なっている → `bottom`
 * - `panel.right ≤ editor.left` (editor の完全に左) → `left`
 * - `panel.left ≥ editor.right` (editor の完全に右) → `right`
 * - その他 (重なり / 上方 / 横列の bottom) → null
 *
 * bottom 判定に「水平方向の重なり」を要求するのが重要。
 * これがないと、editor の高さが (横列パネルの追加で) 縮んだ瞬間に、
 * editor の外側 (左列の下) にいるパネルまで bottom 扱いになる。
 *
 * 4px の tolerance で resize 中の sub-pixel ゆらぎを吸収。
 */
export function detectRegionFromRects(
  panelRect: SimpleRect,
  editorRect: SimpleRect,
): StripeRegion | null {
  if (!editorRect.width || !editorRect.height) return null;
  const tol = 4;
  const horizontallyOverlaps =
    panelRect.right > editorRect.left + tol &&
    panelRect.left < editorRect.right - tol;
  if (panelRect.top >= editorRect.bottom - tol && horizontallyOverlaps) {
    return "bottom";
  }
  if (panelRect.right <= editorRect.left + tol) return "left";
  if (panelRect.left >= editorRect.right - tol) return "right";
  return null;
}

/** Dockview API から panel の actual region を解決 */
export function detectActualRegion(
  api: DockviewApi,
  panelId: PanelId,
): StripeRegion | null {
  const panel = api.getPanel(panelId);
  if (!panel?.group?.element) return null;
  const editorPanel = api.getPanel("editor");
  if (!editorPanel?.group?.element) return null;
  // 同じ tab group (= editor area の tab として並んでいる) は stripe 対象外
  if (panel.group === editorPanel.group) return null;
  return detectRegionFromRects(
    panel.group.element.getBoundingClientRect(),
    editorPanel.group.element.getBoundingClientRect(),
  );
}

/**
 * Dockview group 単位での region 検出。editor group との位置関係で判定。
 * editor group 自身は null を返す。
 */
export function detectGroupRegion(
  api: DockviewApi,
  group: DockviewGroupPanel,
): StripeRegion | null {
  if (!group.element) return null;
  const editorPanel = api.getPanel("editor");
  if (!editorPanel?.group?.element) return null;
  if (group === editorPanel.group) return null;
  return detectRegionFromRects(
    group.element.getBoundingClientRect(),
    editorPanel.group.element.getBoundingClientRect(),
  );
}

/**
 * Region 別に Dockview groups を空間順 (top→bottom / left→right) でソート。
 * editor group は除外。
 */
export function groupsByRegionInSpatialOrder(
  api: DockviewApi,
): Record<StripeRegion, DockviewGroupPanel[]> {
  const result: Record<StripeRegion, DockviewGroupPanel[]> = {
    left: [],
    right: [],
    bottom: [],
  };
  for (const group of api.groups) {
    const region = detectGroupRegion(api, group);
    if (!region) continue;
    result[region].push(group);
  }
  // 縦並び (left/right) は top で sort、横並び (bottom) は left で sort
  result.left.sort(
    (a, b) =>
      a.element.getBoundingClientRect().top -
      b.element.getBoundingClientRect().top,
  );
  result.right.sort(
    (a, b) =>
      a.element.getBoundingClientRect().top -
      b.element.getBoundingClientRect().top,
  );
  result.bottom.sort(
    (a, b) =>
      a.element.getBoundingClientRect().left -
      b.element.getBoundingClientRect().left,
  );
  return result;
}

/**
 * region に対応する代表 slot。Phase 1 では top/left のサブスロットを採用。
 * Phase 2 で top/bottom 分割 UI が入ったら、現在の sub-position を保持する
 * smarter なロジックに差し替える。
 */
export function pickDefaultSlotForRegion(region: StripeRegion): ToolWindowSlot {
  switch (region) {
    case "left":
      return "LT";
    case "right":
      return "RT";
    case "bottom":
      return "BL";
  }
}
