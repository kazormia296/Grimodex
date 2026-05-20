import type { PanelId } from "./panelIds";

/** 永続化スキーマ v2 */
export const LAYOUT_SCHEMA_VERSION = 2 as const;

export type RegionId = "left" | "right" | "bottom";

export type ToolWindowPanelId = Exclude<PanelId, "editor">;

export interface SlotState {
  id: string;
  /** region 主軸方向の比率。open slot 間の相対比のみ使用。 */
  sizeRatio: number;
  /** 登録順 = stripe アイコン順 */
  panels: ToolWindowPanelId[];
  /** null = 折りたたみ */
  activePanel: ToolWindowPanelId | null;
}

export interface RegionState {
  /** content 領域サイズ (left/right=幅, bottom=高さ)。折りたたみ時も保持。 */
  size: number;
  slots: SlotState[];
}

export interface LayoutState {
  regions: Record<RegionId, RegionState>;
}

export interface PersistedLayout {
  layoutVersion: typeof LAYOUT_SCHEMA_VERSION;
  state: LayoutState;
  activePresetId?: string;
  /** Stripe に表示しない tool window（slot 登録は維持） */
  hiddenStripePanels?: ToolWindowPanelId[];
}

export interface CustomLayoutPreset {
  id: string;
  name: string;
  state: LayoutState;
}

export type LayoutValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface PanelLocation {
  region: RegionId;
  slotIndex: number;
  slot: SlotState;
}
