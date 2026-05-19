import { useEffect, useMemo, useState } from "react";
import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  DEFAULT_SLOT_MAP,
  SLOT_TO_REGION,
  type StripeRegion,
} from "./toolWindowDefaults";

export interface StripePanel {
  id: Exclude<PanelId, "editor">;
  /**
   * Panel が Dockview に mount されている (group が存在する) か。
   * - 同じ tab group の「裏 tab」も visible=true
   * - 閉じている (Dockview に居ない) なら false
   * - Undock 中 (Phase 3) は false (overlay 層で別途描画)
   */
  visible: boolean;
  /**
   * 画面に実際に内容が出ているか。
   * - Dockview にいるとき: 所属 group の `activePanel === panel` (= active tab)
   * - Undock 中 (Phase 3): true (overlay は常に表示)
   * - 閉じている: false
   */
  active: boolean;
}

export type StripePanelsByRegion = Record<StripeRegion, StripePanel[]>;

/**
 * Stripe に icon を出すべき panel を region 別に分類。
 *
 * Source of truth:
 * - `stripePanelIds` — 一度でも開かれた panel の id set。閉じても残るので icon が消えない
 * - `toolWindows[id].slot` — panel の last-known region。`syncSlotsToActualRegions` で自動更新
 * - `dockviewApi.getPanel(id)` — visible 判定 (Dockview に居るか)
 * - `panel.group?.activePanel` — active 判定 (内容が画面に出ているか)
 *
 * Stripe の hide ロジック: `result[region].length === 0` で shell 側が region を潰す。
 */
export function useStripePanelsByRegion(): StripePanelsByRegion {
  const api = useLayoutStore((s) => s.dockviewApi);
  const stripePanelIds = useLayoutStore((s) => s.stripePanelIds);
  const toolWindows = useLayoutStore((s) => s.toolWindows);
  const undockedPanels = useLayoutStore((s) => s.undockedPanels);

  // panel 増減 / active tab 切替で再評価
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!api) return;
    const bump = () => setVersion((v) => v + 1);
    const d1 = api.onDidAddPanel(bump);
    const d2 = api.onDidRemovePanel(bump);
    const d3 = api.onDidActivePanelChange(bump);
    return () => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
    };
  }, [api]);

  return useMemo(
    () => {
      const result: StripePanelsByRegion = { left: [], right: [], bottom: [] };
      for (const rawId of stripePanelIds) {
        if (rawId === "editor") continue;
        const id = rawId as Exclude<PanelId, "editor">;

        let visible = false;
        let active = false;
        if (undockedPanels.has(id)) {
          visible = false; // overlay は Dockview 外
          active = true; // overlay は画面に出ている
        } else if (api) {
          const panel = api.getPanel(id);
          visible = !!panel;
          active = !!panel && panel.group?.activePanel === panel;
        }

        const slot = toolWindows[id]?.slot ?? DEFAULT_SLOT_MAP[id];
        const region = SLOT_TO_REGION[slot];
        result[region].push({ id, visible, active });
      }
      return result;
    },
    // version は Dockview の onDidAddPanel/onDidRemovePanel/onDidActivePanelChange で bump
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, stripePanelIds, toolWindows, undockedPanels, version],
  );
}
