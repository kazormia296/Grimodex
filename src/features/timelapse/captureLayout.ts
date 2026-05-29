/**
 * 執筆タイムラプス — パネル/レイアウトの forward-only 記録アダプタ (P0, §17)。
 *
 * 「Grimodex で書いている感じ」を後で動画再現するため、パネル配置・分割・
 * editor 開閉などの UI 状態を時系列で残す。各イベントは **自己完結の full
 * LayoutState snapshot**(diff ではない)。diff fold は wipe/flush 取りこぼし 1 件で
 * 以降全ズレするのに対し、full snapshot は単独で復元でき免疫。
 *
 * 発火点は layoutStore の `scheduleSave`(500ms デバウンスの永続化チョークポイント)
 * 1 点。live ドラッグの `setRegionSizeLive` は scheduleSave を呼ばないため
 * 60fps の volume bomb にならず、デバウンスが burst を 1 スナップショットに畳む。
 *
 * 注意: recorder は flush(100ms 後) 時に payload を stringify するため、呼び出し側は
 * **必ず clone を渡す**(間に layout が mutate すると記録が壊れる)。
 */

import { recordChangeEvent } from "./recorder";
import type { LayoutState } from "@/features/layout/layoutTypes";

export function recordLayoutSnapshot(input: {
  /** 呼び出し側で clone 済みの LayoutState。 */
  layout: LayoutState;
  activePresetId?: string | null;
  hiddenStripePanels?: string[];
}): void {
  recordChangeEvent({
    domain: "layout",
    opType: "layout.snapshot",
    entityType: "workspace",
    entityId: "workspace",
    // layout は treeNodes に紐づかない。sceneId に非 treeNodes 値を入れると
    // FK 違反で flush が止まるため必ず null。
    sceneId: null,
    payload: {
      layout: input.layout,
      ...(input.activePresetId ? { activePresetId: input.activePresetId } : {}),
      ...(input.hiddenStripePanels && input.hiddenStripePanels.length > 0
        ? { hiddenStripePanels: input.hiddenStripePanels }
        : {}),
    },
  });
}
