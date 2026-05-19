import type { PanelId } from "./layoutStore";

/**
 * IntelliJ 式の 6 スロット (LT/LB = 左 stripe top/bottom, RT/RB = 右, BL/BR = 下)。
 * Phase 1 では region 単位 (left/right/bottom) でのみ解決し、6 細分化は Phase 2。
 */
export type ToolWindowSlot = "LT" | "LB" | "RT" | "RB" | "BL" | "BR";

/** Pin/Unpin/Undock の表示モード。Phase 3 で完全実装 */
export type ViewMode = "docked-pinned" | "docked-unpinned" | "undocked";

/** Stripe が出る 3 方向 */
export type StripeRegion = "left" | "right" | "bottom";

/** Per-panel preferred state. 値欠如 = DEFAULT_SLOT_MAP + DEFAULT_VIEW_MODE */
export interface ToolWindowState {
  slot: ToolWindowSlot;
  viewMode: ViewMode;
  undockSize?: { width: number; height: number };
}

/** 初回 open 時の preferred slot。ユーザは stripe DnD で上書きできる (Phase 2) */
export const DEFAULT_SLOT_MAP: Record<
  Exclude<PanelId, "editor">,
  ToolWindowSlot
> = {
  scenes: "LT",
  codex: "LB",
  "codex-quick": "LB",
  "command-center-results": "LB",
  chat: "RT",
  "chat-history": "RT",
  attribution: "RB",
  timeline: "BL",
  map: "BL",
  grid: "BL",
  matrix: "BL",
  snippets: "BR",
  kouetsu: "BR",
  foreshadow: "BR",
  "trash-bin": "BR",
};

export const SLOT_TO_REGION: Record<ToolWindowSlot, StripeRegion> = {
  LT: "left",
  LB: "left",
  RT: "right",
  RB: "right",
  BL: "bottom",
  BR: "bottom",
};

export const DEFAULT_VIEW_MODE: ViewMode = "docked-pinned";

export const DEFAULT_UNDOCK_SIZE = { width: 320, height: 400 } as const;

/** stripe 自体の幅 (px)。ユーザが Phase 4 で変更可能 */
export const DEFAULT_STRIPE_SIZES: Record<StripeRegion, number> = {
  left: 32,
  right: 32,
  bottom: 32,
};

export const DEFAULT_STRIPE_VISIBILITY: Record<StripeRegion, boolean> = {
  left: true,
  right: true,
  bottom: true,
};

/** Panel の effective region。toolWindows override > DEFAULT_SLOT_MAP の優先順位 */
export function getStripeRegion(
  panelId: Exclude<PanelId, "editor">,
  override?: ToolWindowState,
): StripeRegion {
  if (override) return SLOT_TO_REGION[override.slot];
  return SLOT_TO_REGION[DEFAULT_SLOT_MAP[panelId]];
}

/** Panel の effective slot */
export function getEffectiveSlot(
  panelId: Exclude<PanelId, "editor">,
  override?: ToolWindowState,
): ToolWindowSlot {
  return override?.slot ?? DEFAULT_SLOT_MAP[panelId];
}

/** 全 togglable panel id (DEFAULT_SLOT_MAP のキー = editor 除く全 panel) */
export const TOOL_WINDOW_PANEL_IDS: ReadonlyArray<Exclude<PanelId, "editor">> =
  Object.keys(DEFAULT_SLOT_MAP) as Exclude<PanelId, "editor">[];
