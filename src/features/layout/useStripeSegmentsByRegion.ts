import { useEffect, useMemo, useState } from "react";
import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  getEffectiveIndexInRegion,
  getEffectiveSlot,
  getStripeRegion,
  type StripeRegion,
} from "./toolWindowDefaults";
import { groupsByRegionInSpatialOrder } from "./stripeRegionDetection";
import type { StripePanel } from "./useStripePanelsByRegion";

/**
 * 1 segment は 1 Dockview group に対応。
 * groupId が undefined のものは "ghost" (Dockview 上に group が無いが closed icon を出す必要がある時)。
 */
export interface StripeSegment {
  /** Region 内で一意な key (Dockview group id か "ghost-{region}") */
  key: string;
  /** 実 Dockview group の id。virtual ghost segment の場合 undefined */
  groupId?: string;
  /** この segment に属する panel (open + closed snap)。tab 順 → closed 順 */
  panels: StripePanel[];
  /** flex-grow に使う比例値。group の実寸 (vertical: height, horizontal: width)。virtual は 1 */
  sizeRatio: number;
}

export type StripeSegmentsByRegion = Record<StripeRegion, StripeSegment[]>;

const EMPTY_SEGMENTS: StripeSegmentsByRegion = {
  left: [],
  right: [],
  bottom: [],
};

/**
 * Region 別の Stripe segment を返す hook。Y モデルの中核。
 *
 * Segment は Dockview group に 1:1 対応。group の実寸を sizeRatio に反映するので、
 * ToolWindowStripe で flex-grow に渡せば stripe divider が Dockview splitter に追従する。
 *
 * 閉じている panel の配置:
 *   1. groupRef が現在の group に一致 → その segment
 *   2. indexInRegion が segment 範囲内 → その index segment
 *   3. clamp して end
 *   4. region に group が一つも無く closed panel しかない → "ghost" virtual segment 1 個
 */
export function useStripeSegmentsByRegion(): StripeSegmentsByRegion {
  const api = useLayoutStore((s) => s.dockviewApi);
  const stripePanelIds = useLayoutStore((s) => s.stripePanelIds);
  const toolWindows = useLayoutStore((s) => s.toolWindows);
  const undockedPanels = useLayoutStore((s) => s.undockedPanels);

  // Dockview 構造/サイズ変更で再評価
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!api) return;
    let observer: ResizeObserver | null = null;
    const bump = () => setTick((t) => t + 1);

    const refresh = () => {
      observer?.disconnect();
      observer =
        typeof ResizeObserver !== "undefined" ? new ResizeObserver(bump) : null;
      if (observer) {
        for (const group of api.groups) {
          observer.observe(group.element);
        }
      }
      bump();
    };

    refresh();
    const d1 = api.onDidAddPanel(refresh);
    const d2 = api.onDidRemovePanel(refresh);
    const d3 = api.onDidActivePanelChange(bump);
    const d4 = api.onDidLayoutChange(refresh);

    return () => {
      observer?.disconnect();
      d1.dispose();
      d2.dispose();
      d3.dispose();
      d4.dispose();
    };
  }, [api]);

  return useMemo(
    () => {
      if (!api) {
        // Dockview 未初期化: closed panel だけ region 別に ghost segment へ
        const result: StripeSegmentsByRegion = {
          left: [],
          right: [],
          bottom: [],
        };
        const buckets: Record<StripeRegion, StripePanel[]> = {
          left: [],
          right: [],
          bottom: [],
        };
        for (const rawId of stripePanelIds) {
          if (rawId === "editor") continue;
          const id = rawId as Exclude<PanelId, "editor">;
          const region = getStripeRegion(id, toolWindows[id]);
          buckets[region].push({
            id,
            slot: getEffectiveSlot(id, toolWindows[id]),
            visible: false,
            active: undockedPanels.has(id),
          });
        }
        for (const region of ["left", "right", "bottom"] as const) {
          if (buckets[region].length > 0) {
            result[region] = [
              {
                key: `ghost-${region}`,
                panels: buckets[region],
                sizeRatio: 1,
              },
            ];
          }
        }
        return result;
      }

      const groupsByRegion = groupsByRegionInSpatialOrder(api);
      const result: StripeSegmentsByRegion = {
        left: [],
        right: [],
        bottom: [],
      };

      for (const region of ["left", "right", "bottom"] as const) {
        const groups = groupsByRegion[region];
        const isVertical = region !== "bottom";

        // (a) groups から segment 雛形を作成
        const segments: StripeSegment[] = groups.map((g) => {
          const rect = g.element.getBoundingClientRect();
          const size = isVertical ? rect.height : rect.width;
          return {
            key: g.id,
            groupId: g.id,
            panels: [],
            sizeRatio: size > 0 ? size : 1,
          };
        });

        // (b) 開いている panel: 所属 group の segment に tab 順で追加
        const assigned = new Set<string>();
        for (const segment of segments) {
          const group = groups.find((g) => g.id === segment.groupId);
          if (!group) continue;
          for (const dockviewPanel of group.panels) {
            if (dockviewPanel.id === "editor") continue;
            if (!stripePanelIds.has(dockviewPanel.id as PanelId)) continue;
            const id = dockviewPanel.id as Exclude<PanelId, "editor">;
            if (undockedPanels.has(id)) continue; // overlay 側で描画
            segment.panels.push({
              id,
              slot: getEffectiveSlot(id, toolWindows[id]),
              visible: true,
              active: group.activePanel?.id === id,
            });
            assigned.add(id);
          }
        }

        // (c) 閉じている (or undocked) panel: groupRef / indexInRegion でスナップ
        const stragglers: StripePanel[] = [];
        for (const rawId of stripePanelIds) {
          if (rawId === "editor") continue;
          const id = rawId as Exclude<PanelId, "editor">;
          if (assigned.has(id)) continue;
          const state = toolWindows[id];
          const panelRegion = getStripeRegion(id, state);
          if (panelRegion !== region) continue;

          const isUndocked = undockedPanels.has(id);
          const stripePanel: StripePanel = {
            id,
            slot: getEffectiveSlot(id, state),
            visible: false,
            active: isUndocked,
          };

          // 1. groupRef が existing segment に一致
          if (state?.groupRef) {
            const seg = segments.find((s) => s.groupId === state.groupRef);
            if (seg) {
              seg.panels.push(stripePanel);
              continue;
            }
          }
          // 2. indexInRegion でスナップ (clamp)
          if (segments.length > 0) {
            const idx = getEffectiveIndexInRegion(id, state);
            const clamped = Math.max(0, Math.min(idx, segments.length - 1));
            segments[clamped].panels.push(stripePanel);
          } else {
            stragglers.push(stripePanel);
          }
        }

        // (d) Dockview に group が一つも無い region に closed panel しかなければ ghost
        if (segments.length === 0 && stragglers.length > 0) {
          result[region] = [
            {
              key: `ghost-${region}`,
              panels: stragglers,
              sizeRatio: 1,
            },
          ];
        } else {
          result[region] = segments;
        }
      }

      return result;
    },
    // tick は Dockview の event / ResizeObserver で bump
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, stripePanelIds, toolWindows, undockedPanels, tick],
  );
}

/** Test 用: 空の値 */
export const __EMPTY_STRIPE_SEGMENTS = EMPTY_SEGMENTS;
