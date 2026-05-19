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

/**
 * Per-panel preferred state.
 *
 * Y モデルへの移行中:
 * - `slot` は **deprecated** (旧 6 slot 固定モデル)。新コードでは `region` / `groupRef` / `indexInRegion` を使う
 * - `region` / `indexInRegion` は migration で必ず populate される (型上は optional だが load 後は常に有る)
 * - `groupRef` は最後に居た Dockview group id (なければ undefined)
 *
 * 値欠如 = DEFAULT_SLOT_MAP + DEFAULT_REGION_MAP + DEFAULT_INDEX_MAP + DEFAULT_VIEW_MODE
 */
export interface ToolWindowState {
  /** @deprecated Use `region` + `indexInRegion`. Kept during Y migration. */
  slot: ToolWindowSlot;
  /** 最後に居た region (left/right/bottom)。migration 後は必ず populate される */
  region?: StripeRegion;
  /** 最後に居た Dockview group id。group が消えたら fallback で indexInRegion を使う */
  groupRef?: string;
  /** Region 内での 0-based 位置。groupRef が無効なときのスナップ用 */
  indexInRegion?: number;
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

/** Slot → region 内の 0-based index。LT/RT/BL=0, LB/RB/BR=1 */
export const SLOT_TO_INDEX: Record<ToolWindowSlot, number> = {
  LT: 0,
  LB: 1,
  RT: 0,
  RB: 1,
  BL: 0,
  BR: 1,
};

/** Default region (DEFAULT_SLOT_MAP から導出) */
export const DEFAULT_REGION_MAP: Record<
  Exclude<PanelId, "editor">,
  StripeRegion
> = Object.fromEntries(
  Object.entries(DEFAULT_SLOT_MAP).map(([id, slot]) => [
    id,
    SLOT_TO_REGION[slot],
  ]),
) as Record<Exclude<PanelId, "editor">, StripeRegion>;

/** Default index in region (DEFAULT_SLOT_MAP から導出) */
export const DEFAULT_INDEX_MAP: Record<
  Exclude<PanelId, "editor">,
  number
> = Object.fromEntries(
  Object.entries(DEFAULT_SLOT_MAP).map(([id, slot]) => [
    id,
    SLOT_TO_INDEX[slot],
  ]),
) as Record<Exclude<PanelId, "editor">, number>;

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

/** Panel の effective region。新フィールド region > 旧 slot > DEFAULT_REGION_MAP の優先順位 */
export function getStripeRegion(
  panelId: Exclude<PanelId, "editor">,
  override?: ToolWindowState,
): StripeRegion {
  if (override?.region) return override.region;
  if (override?.slot) return SLOT_TO_REGION[override.slot];
  return DEFAULT_REGION_MAP[panelId];
}

/** Panel の effective index in region。indexInRegion > slot 導出 > DEFAULT_INDEX_MAP */
export function getEffectiveIndexInRegion(
  panelId: Exclude<PanelId, "editor">,
  override?: ToolWindowState,
): number {
  if (override?.indexInRegion != null) return override.indexInRegion;
  if (override?.slot) return SLOT_TO_INDEX[override.slot];
  return DEFAULT_INDEX_MAP[panelId];
}

/** Panel の effective slot (deprecated; 旧 6 slot モデルとの橋渡し用) */
export function getEffectiveSlot(
  panelId: Exclude<PanelId, "editor">,
  override?: ToolWindowState,
): ToolWindowSlot {
  return override?.slot ?? DEFAULT_SLOT_MAP[panelId];
}

/**
 * 旧 slot のみ持つ state を新形式 (region + indexInRegion) で補完。
 * 保存済み layout を load した時の migration entry point。
 *
 * 既に新形式の state (`region` がある) はそのまま返す。
 */
export function migrateToolWindowState(
  panelId: Exclude<PanelId, "editor">,
  raw: Partial<ToolWindowState> | undefined,
): ToolWindowState {
  const slot = raw?.slot ?? DEFAULT_SLOT_MAP[panelId];
  const region = raw?.region ?? SLOT_TO_REGION[slot];
  const indexInRegion = raw?.indexInRegion ?? SLOT_TO_INDEX[slot];
  return {
    slot,
    region,
    groupRef: raw?.groupRef,
    indexInRegion,
    viewMode: raw?.viewMode ?? DEFAULT_VIEW_MODE,
    undockSize: raw?.undockSize,
  };
}

/**
 * toolWindows レコード全体を migrate。load 時に1回呼ぶ。
 */
export function migrateToolWindowsRecord(
  raw: Partial<Record<PanelId, Partial<ToolWindowState>>> | undefined,
): Partial<Record<PanelId, ToolWindowState>> {
  if (!raw) return {};
  const out: Partial<Record<PanelId, ToolWindowState>> = {};
  for (const [id, state] of Object.entries(raw)) {
    if (id === "editor") continue;
    const panelId = id as Exclude<PanelId, "editor">;
    out[panelId] = migrateToolWindowState(panelId, state);
  }
  return out;
}

/** 全 togglable panel id (DEFAULT_SLOT_MAP のキー = editor 除く全 panel) */
export const TOOL_WINDOW_PANEL_IDS: ReadonlyArray<Exclude<PanelId, "editor">> =
  Object.keys(DEFAULT_SLOT_MAP) as Exclude<PanelId, "editor">[];
