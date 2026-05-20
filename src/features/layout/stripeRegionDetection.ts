import type { DockviewApi, DockviewGroupPanel } from "dockview-react";
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
 * Stripe の 1 帯 (band)。stripe 主軸方向で重なる group の集合。
 * - 縦 stripe (左/右): Y 方向で重なる = 左右に並ぶ group が同じ band
 * - 横 stripe (下): X 方向で重なる = 上下に積まれた group が同じ band
 *
 * band が複数 = 主軸方向のスプリット → stripe に divider が出る。
 * 同じ band 内の複数 group = 交差軸スプリット → divider 無しで 1 segment にまとめる。
 */
export interface GroupBand {
  /** band 内の group。交差軸順 (縦 stripe なら left→right, 横なら top→bottom) */
  groups: DockviewGroupPanel[];
  /** stripe 主軸方向の extent (縦 stripe: height, 横 stripe: width) */
  extent: number;
}

/** band クラスタリングの主軸重なり判定 tolerance (px) */
const BAND_TOLERANCE = 4;

/**
 * region 内の groups を主軸方向の interval でクラスタリングして band 配列にする。
 * axis = "vertical" なら Y 方向、"horizontal" なら X 方向で重なりを見る。
 */
function clusterIntoBands(
  groups: DockviewGroupPanel[],
  axis: "vertical" | "horizontal",
): GroupBand[] {
  if (groups.length === 0) return [];
  const items = groups.map((group) => {
    const r = group.element.getBoundingClientRect();
    return {
      group,
      start: axis === "vertical" ? r.top : r.left,
      end: axis === "vertical" ? r.bottom : r.right,
      cross: axis === "vertical" ? r.left : r.top,
    };
  });
  // 主軸 start でソートして greedy interval merge
  items.sort((a, b) => a.start - b.start);

  const bands: { items: typeof items; start: number; end: number }[] = [];
  for (const item of items) {
    const last = bands[bands.length - 1];
    if (last && item.start < last.end - BAND_TOLERANCE) {
      // 主軸方向で重なる → 同じ band (side by side)
      last.items.push(item);
      last.end = Math.max(last.end, item.end);
    } else {
      bands.push({ items: [item], start: item.start, end: item.end });
    }
  }

  return bands.map((band) => ({
    groups: [...band.items]
      .sort((a, b) => a.cross - b.cross)
      .map((it) => it.group),
    extent: band.end - band.start,
  }));
}

/**
 * Region 別に Dockview groups を band にクラスタリングして返す。
 * band 配列は主軸方向の順 (top→bottom / left→right)。editor group は除外。
 */
export function groupBandsByRegion(
  api: DockviewApi,
): Record<StripeRegion, GroupBand[]> {
  const byRegion: Record<StripeRegion, DockviewGroupPanel[]> = {
    left: [],
    right: [],
    bottom: [],
  };
  for (const group of api.groups) {
    const region = detectGroupRegion(api, group);
    if (region) byRegion[region].push(group);
  }
  return {
    left: clusterIntoBands(byRegion.left, "vertical"),
    right: clusterIntoBands(byRegion.right, "vertical"),
    bottom: clusterIntoBands(byRegion.bottom, "horizontal"),
  };
}

/** group id が属する band の index。見つからなければ -1 */
export function findBandIndex(
  bands: ReadonlyArray<GroupBand>,
  groupId: string,
): number {
  return bands.findIndex((b) => b.groups.some((g) => g.id === groupId));
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
