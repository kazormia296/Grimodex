import { useEffect, useMemo, useState } from "react";
import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  getEffectiveIndexInRegion,
  getEffectiveSlot,
  getStripeRegion,
  type StripeRegion,
} from "./toolWindowDefaults";
import { findBandIndex, groupBandsByRegion } from "./stripeRegionDetection";
import type { StripePanel } from "./useStripePanelsByRegion";

/**
 * 1 segment は 1 band (= stripe 主軸方向で重なる Dockview group の集合) に対応。
 * 同じ band 内に複数 group があるのは交差軸スプリット (縦 stripe での左右並び等)。
 * `groupIds` が空配列のものは "ghost" (Dockview 上に group が無いが closed icon を出す時)。
 */
export interface StripeSegment {
  /** Region 内で一意な key (group id を "+" 連結、または "ghost-{region}") */
  key: string;
  /** この band に含まれる Dockview group id 群。ghost segment は空配列 */
  groupIds: string[];
  /** この segment に属する panel (open + closed snap)。tab 順 → closed 順 */
  panels: StripePanel[];
  /** flex-grow に使う比例値。band の主軸 extent (vertical: height, horizontal: width)。ghost は 1 */
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
 * Segment は band (stripe 主軸方向で重なる group の集合) に 1:1 対応。
 * - 縦 stripe で上下に積まれた group → 別 band → 別 segment (間に divider)
 * - 縦 stripe で左右に並んだ group → 同じ band → 1 segment にまとめる (divider 無し)
 * band の主軸 extent を sizeRatio に反映するので、divider が Dockview splitter に追従する。
 *
 * 閉じている panel の配置:
 *   1. groupRef がいずれかの band に含まれる → その segment
 *   2. indexInRegion (band index) でスナップ (clamp)
 *   3. region に band が一つも無く closed panel しかない → "ghost" segment 1 個
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
                groupIds: [],
                panels: buckets[region],
                sizeRatio: 1,
              },
            ];
          }
        }
        return result;
      }

      const bandsByRegion = groupBandsByRegion(api);
      const result: StripeSegmentsByRegion = {
        left: [],
        right: [],
        bottom: [],
      };

      for (const region of ["left", "right", "bottom"] as const) {
        const bands = bandsByRegion[region];

        // (a) band ごとに segment 雛形を作成 (1 band = 1 segment)
        const segments: StripeSegment[] = bands.map((band) => ({
          key: band.groups.map((g) => g.id).join("+"),
          groupIds: band.groups.map((g) => g.id),
          panels: [],
          sizeRatio: band.extent > 0 ? band.extent : 1,
        }));

        // (b) 開いている panel: band 内の各 group の tab 順で追加
        const assigned = new Set<string>();
        bands.forEach((band, bandIndex) => {
          const segment = segments[bandIndex];
          for (const group of band.groups) {
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
        });

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

          // 1. groupRef がいずれかの band に含まれる
          if (state?.groupRef) {
            const bandIdx = findBandIndex(bands, state.groupRef);
            if (bandIdx >= 0) {
              segments[bandIdx].panels.push(stripePanel);
              continue;
            }
          }
          // 2. indexInRegion (band index) でスナップ (clamp)
          if (segments.length > 0) {
            const idx = getEffectiveIndexInRegion(id, state);
            const clamped = Math.max(0, Math.min(idx, segments.length - 1));
            segments[clamped].panels.push(stripePanel);
          } else {
            stragglers.push(stripePanel);
          }
        }

        // (d) band が一つも無い region に closed panel しかなければ ghost
        if (segments.length === 0 && stragglers.length > 0) {
          result[region] = [
            {
              key: `ghost-${region}`,
              groupIds: [],
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
