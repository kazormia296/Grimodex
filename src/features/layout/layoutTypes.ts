import type { PanelId } from "./panelIds";

/** 永続化スキーマ v3 */
export const LAYOUT_SCHEMA_VERSION = 3 as const;

export type RegionId = "left" | "right" | "bottom";

/** side region + center band（DnD / drop target 用） */
export type LayoutRegionId = RegionId | "center";

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

/** center band 内の左→右 segment。editor は 1 つのみ。 */
export type CenterSegment =
  | { id: string; kind: "editor"; sizeRatio: number }
  | {
      id: string;
      kind: "tool";
      sizeRatio: number;
      panels: ToolWindowPanelId[];
      activePanel: ToolWindowPanelId | null;
    };

export type CenterToolSegment = Extract<CenterSegment, { kind: "tool" }>;

export interface CenterState {
  editorOpen: boolean;
  segments: CenterSegment[];
}

/**
 * bottom region がボトム左右の角まで広がるか。
 * true = bottom region が角を取る / false = side stripe が角を取る。
 */
export interface BottomCornerOwnership {
  left: boolean;
  right: boolean;
}

export interface LayoutState {
  regions: Record<RegionId, RegionState>;
  center: CenterState;
  /**
   * editor 単独 collapse 時、再表示で幅を復元するため閉じる直前の左右
   * region サイズを保持する。再表示で消費し、region の手動リサイズで破棄する。
   */
  collapsedEditorRegionSizes?: { left: number; right: number };
  /**
   * ボトム両端の角を bottom region と side stripe のどちらが取るか。
   * 未指定時は both false（side stripe が角を取る = 従来の挙動）。
   */
  bottomCorners?: BottomCornerOwnership;
}

/** v2 永続化（migrate 用） */
export interface LayoutStateV2 {
  regions: Record<RegionId, RegionState>;
}

export interface PersistedLayout {
  layoutVersion: typeof LAYOUT_SCHEMA_VERSION;
  state: LayoutState;
  activePresetId?: string;
  /** Stripe に表示しない tool window（slot 登録は維持） */
  hiddenStripePanels?: ToolWindowPanelId[];
}

/** ビルトインプリセットのユーザー上書き（id は builtin:* でキー管理） */
export interface BuiltinPresetOverride {
  state: LayoutState;
  /** Stripe から外した tool window（slot 登録は state 側に維持） */
  hiddenStripePanels?: ToolWindowPanelId[];
}

export interface CustomLayoutPreset {
  id: string;
  name: string;
  state: LayoutState;
  /** Stripe から外した tool window（slot 登録は state 側に維持） */
  hiddenStripePanels?: ToolWindowPanelId[];
}

export type LayoutValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface PanelLocation {
  region: LayoutRegionId;
  slotIndex: number;
  slot: SlotState;
}
