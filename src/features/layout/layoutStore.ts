import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import i18next from "@/lib/i18n";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import type { GlobalSettings } from "@/features/workspace/store";
import {
  getBuiltinPreset,
  clearLayout,
  type CustomPreset,
} from "./layoutPresets";
import { validateSerializedLayout } from "./layoutValidation";
import {
  DEFAULT_SLOT_MAP,
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
  DEFAULT_VIEW_MODE,
  SLOT_TO_INDEX,
  SLOT_TO_REGION,
  TOOL_WINDOW_PANEL_IDS,
  migrateToolWindowsRecord,
  type StripeRegion,
  type ToolWindowSlot,
  type ToolWindowState,
  type ViewMode,
} from "./toolWindowDefaults";
import {
  detectGroupRegion,
  findBandIndex,
  groupBandsByRegion,
  pickDefaultSlotForRegion,
} from "./stripeRegionDetection";

export type { StripeRegion, ToolWindowSlot, ToolWindowState, ViewMode };

export type PanelId =
  | "scenes"
  | "codex"
  | "chat-history"
  | "editor"
  | "chat"
  | "snippets"
  | "attribution"
  | "codex-quick"
  | "timeline"
  | "map"
  | "kouetsu"
  | "foreshadow"
  | "grid"
  | "matrix"
  | "trash-bin"
  | "command-center-results";

/** MIME type used to transfer panel IDs during external drag operations */
export const PANEL_DRAG_TYPE = "application/grimodex-panel-id";

type InsertRule =
  | {
      panel: PanelId;
      direction: "within" | "left" | "right" | "above" | "below";
    }
  | { panel: null; direction: "left" | "right" | "above" | "below" };

/** Ordered anchor list for each panel — first matching anchor wins */
const PANEL_INSERT_REGISTRY: Record<PanelId, InsertRule[]> = {
  scenes: [
    { panel: "codex", direction: "within" },
    { panel: "codex-quick", direction: "within" },
    { panel: null, direction: "left" },
  ],
  codex: [
    { panel: "snippets", direction: "within" },
    { panel: "codex-quick", direction: "within" },
    { panel: null, direction: "left" },
  ],
  "codex-quick": [
    { panel: "codex", direction: "within" },
    { panel: "scenes", direction: "below" },
    { panel: null, direction: "left" },
  ],
  chat: [
    { panel: "chat-history", direction: "within" },
    { panel: null, direction: "right" },
  ],
  "chat-history": [
    { panel: "chat", direction: "within" },
    { panel: null, direction: "right" },
  ],
  snippets: [
    { panel: "attribution", direction: "within" },
    { panel: "codex", direction: "within" },
    { panel: null, direction: "below" },
  ],
  attribution: [
    { panel: "editor", direction: "below" },
    { panel: "snippets", direction: "within" },
    { panel: null, direction: "below" },
  ],
  timeline: [
    { panel: "snippets", direction: "within" },
    { panel: "attribution", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  map: [
    { panel: "timeline", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  kouetsu: [
    { panel: "attribution", direction: "within" },
    { panel: "snippets", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  foreshadow: [
    { panel: "timeline", direction: "within" },
    { panel: "attribution", direction: "within" },
    { panel: "snippets", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  grid: [
    { panel: "timeline", direction: "within" },
    { panel: "map", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  matrix: [
    { panel: "grid", direction: "within" },
    { panel: "timeline", direction: "within" },
    { panel: "map", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  "trash-bin": [
    { panel: "snippets", direction: "within" },
    { panel: "attribution", direction: "within" },
    { panel: "editor", direction: "below" },
    { panel: null, direction: "below" },
  ],
  "command-center-results": [
    { panel: "chat", direction: "within" },
    { panel: "chat-history", direction: "within" },
    { panel: null, direction: "right" },
  ],
  editor: [
    { panel: "scenes", direction: "right" },
    { panel: "codex", direction: "right" },
    { panel: "codex-quick", direction: "right" },
    { panel: null, direction: "right" },
  ],
};

export type InsertPosition =
  | { referencePanel: string; direction: string }
  | { direction: string };

/** Resolve the best-fit insert position for a panel using the ordered anchor registry */
export function resolveInsertPosition(
  api: Pick<DockviewApi, "getPanel">,
  panelId: PanelId,
): InsertPosition {
  for (const rule of PANEL_INSERT_REGISTRY[panelId]) {
    if (rule.panel === null) return { direction: rule.direction };
    if (rule.panel !== panelId && api.getPanel(rule.panel)) {
      return { referencePanel: rule.panel, direction: rule.direction };
    }
  }
  return { direction: "right" };
}

/**
 * Region (left/right/bottom) 単位で insert position を解決する Phase 1 用ロジック。
 *
 * 「同 region に既存 panel があればその group に tab として join、なければ region 方向に新 group」。
 * editor を anchor にしないことで editor group が split されない invariant を守る。
 *
 * **effective slot** (= override > default) で region を判定するのが重要:
 * ユーザーが panel X を別 region に動かしている場合、X は元の region の anchor 候補から外れ、
 * 新しい region で anchor 候補になる。これを無視すると、復元時に icon stripe と
 * 異なる region に panel が配置される。
 */
export function resolveInsertPositionForRegion(
  api: Pick<DockviewApi, "getPanel">,
  region: StripeRegion,
  toolWindows?: Partial<Record<PanelId, ToolWindowState>>,
): InsertPosition {
  for (const id of TOOL_WINDOW_PANEL_IDS) {
    const slot = toolWindows?.[id]?.slot ?? DEFAULT_SLOT_MAP[id];
    if (SLOT_TO_REGION[slot] !== region) continue;
    if (api.getPanel(id)) {
      return { referencePanel: id, direction: "within" };
    }
  }
  switch (region) {
    case "left":
      return { direction: "left" };
    case "right":
      return { direction: "right" };
    case "bottom":
      return { direction: "below" };
  }
}

/**
 * Slot 単位で insert position を解決する Phase 2 用ロジック。
 *
 * 同 slot に既存 panel があれば within、なければ兄弟 slot の panel に対して
 * 上下/左右の方向で配置する。editor は常に候補外。
 *
 * | slot | 兄弟 slot | 兄弟がいる場合の direction |
 * |------|----------|------------------------|
 * | LT   | LB       | above (LT は LB の上)   |
 * | LB   | LT       | below (LB は LT の下)   |
 * | RT   | RB       | above                  |
 * | RB   | RT       | below                  |
 * | BL   | BR       | left (BL は BR の左)    |
 * | BR   | BL       | right (BR は BL の右)   |
 */
export function resolveInsertPositionForSlot(
  api: Pick<DockviewApi, "getPanel">,
  slot: ToolWindowSlot,
  toolWindows?: Partial<Record<PanelId, ToolWindowState>>,
): InsertPosition {
  const SIBLING: Record<ToolWindowSlot, ToolWindowSlot> = {
    LT: "LB",
    LB: "LT",
    RT: "RB",
    RB: "RT",
    BL: "BR",
    BR: "BL",
  };
  const SIBLING_DIR: Record<ToolWindowSlot, string> = {
    LT: "above",
    LB: "below",
    RT: "above",
    RB: "below",
    BL: "left",
    BR: "right",
  };

  // 同 slot に既存 panel があれば within
  for (const id of TOOL_WINDOW_PANEL_IDS) {
    const effectiveSlot = toolWindows?.[id]?.slot ?? DEFAULT_SLOT_MAP[id];
    if (effectiveSlot !== slot) continue;
    if (api.getPanel(id)) return { referencePanel: id, direction: "within" };
  }

  // 兄弟 slot の panel に相対配置
  const siblingSlot = SIBLING[slot];
  for (const id of TOOL_WINDOW_PANEL_IDS) {
    const effectiveSlot = toolWindows?.[id]?.slot ?? DEFAULT_SLOT_MAP[id];
    if (effectiveSlot !== siblingSlot) continue;
    if (api.getPanel(id)) {
      return { referencePanel: id, direction: SIBLING_DIR[slot] };
    }
  }

  // フォールバック: region 方向
  const region = SLOT_TO_REGION[slot];
  switch (region) {
    case "left":
      return { direction: "left" };
    case "right":
      return { direction: "right" };
    case "bottom":
      return { direction: "below" };
  }
}

/** Human-readable panel title resolved via i18n */
export function getPanelTitle(id: PanelId): string {
  return i18next.t(`layout.panel.${id}`);
}

/** Re-apply i18n panel titles to all live dockview panels (call after language change or layout restore) */
export function refreshPanelTitles(api: DockviewApi) {
  for (const panel of api.panels) {
    const title = getPanelTitle(panel.id as PanelId);
    panel.api.setTitle(title);
  }
}

interface LayoutState {
  /** Dockview API reference — set once in onReady */
  dockviewApi: DockviewApi | null;
  setDockviewApi: (api: DockviewApi) => void;

  /** Toggle a panel: if visible & active → close it; otherwise → show & focus */
  togglePanel: (panel: PanelId) => void;

  /** Show a panel without closing it if already active */
  showPanel: (panel: PanelId) => void;

  /** Check whether a panel exists in the current layout */
  isPanelVisible: (panel: PanelId) => boolean;

  /** Load persisted layout from global settings; returns the serialized data or null */
  loadLayout: () => Promise<SerializedDockview | null>;
  /** Save current layout to global settings (debounced internally) */
  saveLayout: () => void;

  /* ── Tool window stripe state (IntelliJ 式 3 方向サイドバー) ── */

  /** Per-panel preferred slot/view-mode override. 値欠如 = DEFAULT_SLOT_MAP + DEFAULT_VIEW_MODE */
  toolWindows: Partial<Record<PanelId, ToolWindowState>>;
  /** Phase 3 で値が入る。Undock 中の panel id set (Dockview 外で overlay 描画) */
  undockedPanels: Set<PanelId>;
  /**
   * Stripe に icon を出している panel 一覧。
   * - `onDidAddPanel` で自動追加 (一度でも開かれた panel は icon が残る)。
   * - 閉じても (`onDidRemovePanel`) この set からは消えない → icon が stripe に残り、
   *   inactive 表示でクリックすると再オープン。
   * - `removePanelFromStripe` で明示的に外す (Phase 2 の右クリック用)。
   */
  stripePanelIds: Set<PanelId>;
  /** Stripe ごとの幅 (px)。Phase 4 で resize 永続化 */
  stripeSizes: Record<StripeRegion, number>;
  /** Stripe 自体の表示/非表示 */
  stripeVisibility: Record<StripeRegion, boolean>;

  /** Slot を変更 (stripe DnD or context menu からの再割当) */
  setToolWindowSlot: (panel: PanelId, slot: ToolWindowSlot) => void;
  /** Stripe icon の登録を外す (Phase 2 の右クリック menu 等から呼ぶ想定) */
  removePanelFromStripe: (panel: PanelId) => void;
  /** View Mode を変更 (Phase 3 で使用) */
  setViewMode: (panel: PanelId, mode: ViewMode) => void;
  /** Undock overlay のサイズを記録 (Phase 3) */
  setUndockSize: (
    panel: PanelId,
    size: { width: number; height: number },
  ) => void;
  /** Pinned ↔ Unpinned 切替 (Phase 3) */
  togglePin: (panel: PanelId) => void;
  /** Stripe の幅 (Phase 4) */
  setStripeSize: (region: StripeRegion, px: number) => void;
  /** Stripe 全体の visibility (Phase 4) */
  setStripeVisibility: (region: StripeRegion, visible: boolean) => void;

  /**
   * 唯一の panel 配置入口。
   * - panel が visible なら focus
   * - 未配置なら preferred slot から region を解決して新規 add
   * - togglePanel / showPanel / handlePanelDrop / keyboard shortcut から経由
   */
  openPanelAtSlot: (panel: PanelId, opts?: { focus?: boolean }) => void;

  /**
   * Panel を指定 slot に物理移動する (Phase 2)。
   * - toolWindows slot を更新する
   * - visible 中なら removePanel → openPanelAtSlot で再配置
   * - closed なら slot 設定のみ更新
   * - editor は no-op
   */
  moveToSlot: (panel: PanelId, slot: ToolWindowSlot) => void;

  /**
   * Panel を指定 Dockview group 内に物理移動する (Y モデル)。
   * - target group が source と同じ region でない場合は no-op (cross-region 拒否)
   * - 既に同じ group 内なら no-op
   * - layout lock 中は no-op
   * - toolWindows の region / groupRef / indexInRegion を更新
   * - editor は no-op
   */
  moveToGroup: (panel: PanelId, targetGroupId: string) => void;

  /**
   * Panel を指定 region に移動する (Y モデル, コンテキストメニュー用)。
   * - region 内の既存 group があればそこに合流 (groupRef があれば優先、無ければ先頭)
   * - region に group が無ければ新規 region を作成 (absolute direction)
   * - 既に同じ region に居る (open) なら no-op
   * - layout lock 中は no-op
   * - editor は no-op
   */
  moveToRegion: (panel: PanelId, region: StripeRegion) => void;

  /** Tool window 設定を global-settings から読み込み (handleReady で呼ぶ) */
  loadToolWindowSettings: () => Promise<void>;

  /* ── Preset management ── */

  /** User-saved custom presets */
  customPresets: CustomPreset[];
  /** Currently active preset ID (builtin:* or custom UUID) */
  activePresetId: string | null;

  /** Load presets and active preset ID from global settings */
  loadPresets: () => Promise<void>;
  /** Apply a preset by ID (builtin or custom) */
  applyPreset: (id: string) => void;
  /** Save the current layout as a named custom preset */
  saveCurrentAsPreset: (name: string) => Promise<void>;
  /** Delete a custom preset */
  deletePreset: (id: string) => Promise<void>;
  /** Rename a custom preset */
  renamePreset: (id: string, name: string) => Promise<void>;

  /* ── Layout lock ── */

  /** When true, panels cannot be closed, dragged, or rearranged */
  layoutLocked: boolean;
  /** Toggle the layout lock on/off */
  toggleLayoutLock: () => void;

  /** Reset layout to builtin default and clear saved layout */
  resetToDefaultLayout: () => Promise<void>;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Stripe icon に登録されている panel について、Dockview 上の actual position
 * (region / group id / band index) に合わせて toolWindows を追従させる。
 *
 * - 自由ドラッグで region 跨ぎ移動 → region 追従
 * - 同 region 内で別 group に移動 → groupRef 追従
 * - splitter ドラッグで band が並べ替わった → indexInRegion (band index) 追従
 * - 閉じている panel は更新しない (groupRef / indexInRegion は最後に居た位置を保持)
 */
function syncSlotsToActualRegions(
  api: DockviewApi,
  get: () => LayoutState,
  set: (partial: Partial<LayoutState>) => void,
) {
  const stripeIds = get().stripePanelIds;
  if (stripeIds.size === 0) return;

  const bandsByRegion = groupBandsByRegion(api);
  const updates: Partial<Record<PanelId, ToolWindowState>> = {};
  let changed = false;

  for (const id of stripeIds) {
    if (id === "editor") continue;

    const panel = api.getPanel(id);
    if (!panel?.group) continue; // 閉じている → 状態を保持

    const region = detectGroupRegion(api, panel.group);
    if (!region) continue;

    const groupId = panel.group.id;
    const bandIndex = findBandIndex(bandsByRegion[region], groupId);

    const current = get().toolWindows[id];
    const currentRegion =
      current?.region ??
      SLOT_TO_REGION[
        current?.slot ?? DEFAULT_SLOT_MAP[id as Exclude<PanelId, "editor">]
      ];

    // 何も変わっていないなら skip (idempotent)
    if (
      currentRegion === region &&
      current?.groupRef === groupId &&
      current?.indexInRegion === bandIndex
    ) {
      continue;
    }

    const newSlot = pickDefaultSlotForRegion(region);
    updates[id] = {
      ...current,
      slot: newSlot,
      region,
      groupRef: groupId,
      indexInRegion: bandIndex >= 0 ? bandIndex : 0,
      viewMode: current?.viewMode ?? DEFAULT_VIEW_MODE,
    };
    changed = true;
  }

  if (changed) {
    set({ toolWindows: { ...get().toolWindows, ...updates } });
  }
}

/**
 * Dockview の全 group タブヘッダを非表示にする (IntelliJ 風)。
 *
 * - ツールウィンドウ group → 切替・開閉は stripe アイコンが担う
 * - editor group → 章/シーン切替は SceneEditor 自身の TabBar が担う
 *
 * エディタ領域はエディタ専用 (ツールウィンドウは tab 化させない — handlePanelDrop 参照)
 * なので editor group は常に "editor" 単独。よって例外なく全ヘッダを隠せる。
 */
function hideAllGroupHeaders(api: DockviewApi) {
  for (const group of api.groups) {
    group.header.hidden = true;
  }
}

function scheduleSave(get: () => LayoutState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const api = get().dockviewApi;
    if (!api) return;
    try {
      const layout = api.toJSON();
      // Skip saving degenerate layouts (e.g. during drag/resize transitions)
      const check = validateSerializedLayout(layout);
      if (!check.valid) return;
      const current = await invoke<GlobalSettings>("get_global_settings");
      await invoke("save_global_settings", {
        settings: {
          ...current,
          layout,
          toolWindows: get().toolWindows,
          stripePanelIds: Array.from(get().stripePanelIds),
          stripeSizes: get().stripeSizes,
          stripeVisibility: get().stripeVisibility,
        },
      });
    } catch {
      // Ignore save errors silently
    }
  }, 500);
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  dockviewApi: null,

  setDockviewApi(api) {
    set({ dockviewApi: api });

    // Apply lock state to newly added groups
    api.onDidAddGroup((group) => {
      if (get().layoutLocked) {
        group.locked = true;
      }
      hideAllGroupHeaders(api);
    });

    // 一度でも追加された panel は stripe に icon を残す (閉じても消えない)
    api.onDidAddPanel((panel) => {
      const id = panel.id as PanelId;
      if (id === "editor") return;
      const current = get().stripePanelIds;
      if (current.has(id)) return;
      const next = new Set(current);
      next.add(id);
      set({ stripePanelIds: next });
    });

    // 自由ドラッグで panel が別 region に動いたら slot を追従させる
    // (これで close → reopen 時に最後にあった region に戻り、icon もそこに残る)
    api.onDidLayoutChange(() => {
      syncSlotsToActualRegions(api, get, set);
      hideAllGroupHeaders(api);
      scheduleSave(get);
    });
  },

  togglePanel(panelId) {
    const api = get().dockviewApi;
    if (!api) return;

    const panel = api.getPanel(panelId);
    if (panel && panel.group?.activePanel === panel) {
      api.removePanel(panel);
      return;
    }
    get().openPanelAtSlot(panelId);
  },

  showPanel(panelId) {
    const api = get().dockviewApi;
    if (!api) return;
    get().openPanelAtSlot(panelId, { focus: true });
  },

  isPanelVisible(panelId) {
    const api = get().dockviewApi;
    if (!api) return false;
    if (get().undockedPanels.has(panelId)) return true;
    return api.getPanel(panelId) !== undefined;
  },

  /* ── Tool window stripe state ── */

  toolWindows: {},
  undockedPanels: new Set<PanelId>(),
  stripePanelIds: new Set<PanelId>(),
  stripeSizes: { ...DEFAULT_STRIPE_SIZES },
  stripeVisibility: { ...DEFAULT_STRIPE_VISIBILITY },

  setToolWindowSlot(panelId, slot) {
    const current = get().toolWindows[panelId];
    // slot 変更時は region と indexInRegion も追従させる (Y migration consistency)
    const next: ToolWindowState = {
      slot,
      region: SLOT_TO_REGION[slot],
      indexInRegion: SLOT_TO_INDEX[slot],
      // groupRef は slot 変更でリセット (どの group に居たかは分からなくなる)
      groupRef: undefined,
      viewMode: current?.viewMode ?? DEFAULT_VIEW_MODE,
      ...(current?.undockSize ? { undockSize: current.undockSize } : {}),
    };
    set({ toolWindows: { ...get().toolWindows, [panelId]: next } });
    scheduleSave(get);
  },

  removePanelFromStripe(panelId) {
    const current = get().stripePanelIds;
    if (!current.has(panelId)) return;
    const next = new Set(current);
    next.delete(panelId);
    set({ stripePanelIds: next });
    scheduleSave(get);
  },

  setViewMode(panelId, mode) {
    const current = get().toolWindows[panelId];
    if (panelId === "editor") return;
    const slot =
      current?.slot ?? DEFAULT_SLOT_MAP[panelId as Exclude<PanelId, "editor">];
    // 新フィールド (region / groupRef / indexInRegion) は触らず維持
    const next: ToolWindowState = {
      slot,
      region: current?.region,
      groupRef: current?.groupRef,
      indexInRegion: current?.indexInRegion,
      viewMode: mode,
      ...(current?.undockSize ? { undockSize: current.undockSize } : {}),
    };
    set({ toolWindows: { ...get().toolWindows, [panelId]: next } });
    scheduleSave(get);
  },

  setUndockSize(panelId, size) {
    const current = get().toolWindows[panelId];
    if (panelId === "editor") return;
    const slot =
      current?.slot ?? DEFAULT_SLOT_MAP[panelId as Exclude<PanelId, "editor">];
    const next: ToolWindowState = {
      slot,
      region: current?.region,
      groupRef: current?.groupRef,
      indexInRegion: current?.indexInRegion,
      viewMode: current?.viewMode ?? DEFAULT_VIEW_MODE,
      undockSize: size,
    };
    set({ toolWindows: { ...get().toolWindows, [panelId]: next } });
    scheduleSave(get);
  },

  togglePin(panelId) {
    if (panelId === "editor") return;
    const current = get().toolWindows[panelId];
    const currentMode = current?.viewMode ?? DEFAULT_VIEW_MODE;
    const nextMode: ViewMode =
      currentMode === "docked-pinned" ? "docked-unpinned" : "docked-pinned";
    get().setViewMode(panelId, nextMode);
  },

  setStripeSize(region, px) {
    set({ stripeSizes: { ...get().stripeSizes, [region]: px } });
    scheduleSave(get);
  },

  setStripeVisibility(region, visible) {
    set({ stripeVisibility: { ...get().stripeVisibility, [region]: visible } });
    scheduleSave(get);
  },

  openPanelAtSlot(panelId, opts) {
    const api = get().dockviewApi;
    if (!api) return;

    // Undock 中なら overlay layer に任せる (Phase 3)
    if (get().undockedPanels.has(panelId)) return;

    const existing = api.getPanel(panelId);
    if (existing) {
      if (opts?.focus !== false) existing.api.setActive();
      return;
    }

    if (panelId === "editor") {
      // Editor は通常 preset で作成される。フォールバックとして右に追加
      api.addPanel({
        id: "editor",
        component: "editor",
        title: getPanelTitle("editor"),
        position: { direction: "right" },
        minimumWidth: 320,
      });
      return;
    }

    const toolWindows = get().toolWindows;
    const override = toolWindows[panelId];
    const slot =
      override?.slot ?? DEFAULT_SLOT_MAP[panelId as Exclude<PanelId, "editor">];
    const position = resolveInsertPositionForSlot(api, slot, toolWindows);

    api.addPanel({
      id: panelId,
      component: panelId,
      title: getPanelTitle(panelId),
      position,
    });
  },

  moveToSlot(panelId, slot) {
    const api = get().dockviewApi;
    if (!api || panelId === "editor") return;
    if (get().layoutLocked) return;

    // slot 設定を先に更新 (resolveInsertPositionForSlot がこれを参照する)
    get().setToolWindowSlot(panelId, slot);

    // 可視中なら物理移動: removePanel → 直接 addPanel で再配置
    const existing = api.getPanel(panelId);
    if (existing) {
      api.removePanel(existing);
      const position = resolveInsertPositionForSlot(
        api,
        slot,
        get().toolWindows,
      );
      api.addPanel({
        id: panelId,
        component: panelId,
        title: getPanelTitle(panelId),
        position,
      });
    }
  },

  moveToGroup(panelId, targetGroupId) {
    const api = get().dockviewApi;
    if (!api || panelId === "editor") return;
    if (get().layoutLocked) return;

    const targetGroup = api.groups.find((g) => g.id === targetGroupId);
    if (!targetGroup) return;

    const targetRegion = detectGroupRegion(api, targetGroup);
    if (!targetRegion) return; // editor group などは reject

    const existing = api.getPanel(panelId);

    if (existing) {
      // 同じ group なら no-op
      if (existing.group?.id === targetGroupId) return;
      // cross-region 許可: source region のチェックはしない
      api.removePanel(existing);
    }

    api.addPanel({
      id: panelId,
      component: panelId,
      title: getPanelTitle(panelId),
      position: { referenceGroup: targetGroup, direction: "within" },
    });

    // toolWindows: region / groupRef / indexInRegion (band index) を更新
    const bands = groupBandsByRegion(api)[targetRegion];
    const bandIndex = findBandIndex(bands, targetGroupId);
    const current = get().toolWindows[panelId];
    const newSlot = pickDefaultSlotForRegion(targetRegion);
    set({
      toolWindows: {
        ...get().toolWindows,
        [panelId]: {
          slot: newSlot,
          region: targetRegion,
          groupRef: targetGroupId,
          indexInRegion: bandIndex >= 0 ? bandIndex : 0,
          viewMode: current?.viewMode ?? DEFAULT_VIEW_MODE,
          ...(current?.undockSize ? { undockSize: current.undockSize } : {}),
        },
      },
    });
    scheduleSave(get);
  },

  moveToRegion(panelId, region) {
    const api = get().dockviewApi;
    if (!api || panelId === "editor") return;
    if (get().layoutLocked) return;

    // 既存 panel と現 region を取得
    const existing = api.getPanel(panelId);
    if (existing?.group) {
      const sourceRegion = detectGroupRegion(api, existing.group);
      if (sourceRegion === region) return; // 既に同 region: Dockview drag で位置調整してもらう
    }

    // 移動先 group を解決:
    //   1. groupRef が target region 内の既存 group と一致 → そこに合流
    //   2. region に band が 1 個以上 → 先頭 band の先頭 group
    //   3. group 無し → 新規 region を作成 (absolute direction)
    const stored = get().toolWindows[panelId];
    const bands = groupBandsByRegion(api)[region];
    const allGroupsInRegion = bands.flatMap((b) => b.groups);

    let targetGroupId: string | undefined;
    if (
      stored?.groupRef &&
      allGroupsInRegion.some((g) => g.id === stored.groupRef)
    ) {
      targetGroupId = stored.groupRef;
    } else if (bands.length > 0) {
      targetGroupId = bands[0].groups[0].id;
    }

    if (existing) api.removePanel(existing);

    if (targetGroupId) {
      const targetGroup = allGroupsInRegion.find(
        (g) => g.id === targetGroupId,
      )!;
      api.addPanel({
        id: panelId,
        component: panelId,
        title: getPanelTitle(panelId),
        position: { referenceGroup: targetGroup, direction: "within" },
      });
    } else {
      // 新規 region: absolute direction で配置
      const absoluteDirection =
        region === "left"
          ? ("left" as const)
          : region === "right"
            ? ("right" as const)
            : ("below" as const);
      api.addPanel({
        id: panelId,
        component: panelId,
        title: getPanelTitle(panelId),
        position: { direction: absoluteDirection },
      });
    }

    // toolWindows を更新
    const newBands = groupBandsByRegion(api)[region];
    const finalPanel = api.getPanel(panelId);
    const finalGroupId = finalPanel?.group?.id;
    const finalIndex = finalGroupId
      ? findBandIndex(newBands, finalGroupId)
      : -1;
    const current = get().toolWindows[panelId];
    const newSlot = pickDefaultSlotForRegion(region);
    set({
      toolWindows: {
        ...get().toolWindows,
        [panelId]: {
          slot: newSlot,
          region,
          groupRef: finalGroupId,
          indexInRegion: finalIndex >= 0 ? finalIndex : 0,
          viewMode: current?.viewMode ?? DEFAULT_VIEW_MODE,
          ...(current?.undockSize ? { undockSize: current.undockSize } : {}),
        },
      },
    });
    scheduleSave(get);
  },

  async loadToolWindowSettings() {
    try {
      const settings = await invoke<GlobalSettings>("get_global_settings");
      const next: Partial<LayoutState> = {};
      const persisted = settings.toolWindows as
        | Partial<Record<PanelId, ToolWindowState>>
        | undefined;
      if (persisted) {
        // Y モデル migration: 旧 slot のみ持つ state を region + indexInRegion で補完
        next.toolWindows = migrateToolWindowsRecord(persisted);
        // Bootstrap undockedPanels from persisted viewMode === "undocked" (Phase 3 用)
        const undocked = new Set<PanelId>();
        for (const [id, state] of Object.entries(persisted)) {
          if (state?.viewMode === "undocked") undocked.add(id as PanelId);
        }
        next.undockedPanels = undocked;
      }
      const persistedStripeIds = settings.stripePanelIds as
        | PanelId[]
        | undefined;
      if (persistedStripeIds) {
        // Merge with any already-populated entries from onDidAddPanel (layout restore が先に走るケース対応)
        const merged = new Set(get().stripePanelIds);
        for (const id of persistedStripeIds) merged.add(id);
        next.stripePanelIds = merged;
      }
      const persistedSizes = settings.stripeSizes as
        | Partial<Record<StripeRegion, number>>
        | undefined;
      if (persistedSizes) {
        next.stripeSizes = {
          ...DEFAULT_STRIPE_SIZES,
          ...persistedSizes,
        };
      }
      const persistedVis = settings.stripeVisibility as
        | Partial<Record<StripeRegion, boolean>>
        | undefined;
      if (persistedVis) {
        next.stripeVisibility = {
          ...DEFAULT_STRIPE_VISIBILITY,
          ...persistedVis,
        };
      }
      if (Object.keys(next).length > 0) set(next);
    } catch {
      // Ignore — fall back to defaults
    }
  },

  async loadLayout() {
    try {
      const settings = await invoke<
        GlobalSettings & { layout?: SerializedDockview }
      >("get_global_settings");
      return settings.layout ?? null;
    } catch {
      // Use default layout on error
    }
    return null;
  },

  saveLayout() {
    scheduleSave(get);
  },

  /* ── Preset management ── */

  customPresets: [],
  activePresetId: null,

  async loadPresets() {
    try {
      const settings = await invoke<GlobalSettings>("get_global_settings");
      const presets: CustomPreset[] = Array.isArray(settings.layoutPresets)
        ? (settings.layoutPresets as CustomPreset[])
        : [];
      set({
        customPresets: presets,
        activePresetId: settings.activeLayoutPresetId ?? null,
      });
    } catch {
      // Ignore
    }
  },

  applyPreset(id) {
    const api = get().dockviewApi;
    if (!api) return;

    const builtin = getBuiltinPreset(id);
    if (builtin) {
      clearLayout(api);
      builtin.build(api);
      set({ activePresetId: id });
      persistActivePresetId(id);
      return;
    }

    const custom = get().customPresets.find((p) => p.id === id);
    if (custom) {
      const preCheck = validateSerializedLayout(custom.layout);
      if (!preCheck.valid) return;
      const snapshot = api.toJSON();
      try {
        api.fromJSON(custom.layout);
        refreshPanelTitles(api);
        set({ activePresetId: id });
        persistActivePresetId(id);
      } catch {
        // Corrupted preset — revert to snapshot
        try {
          api.fromJSON(snapshot);
          refreshPanelTitles(api);
        } catch {
          // ignore
        }
      }
    }
  },

  async saveCurrentAsPreset(name) {
    const api = get().dockviewApi;
    if (!api) return;

    const layout = api.toJSON();
    const id = crypto.randomUUID();
    const preset: CustomPreset = { id, name, builtin: false, layout };
    const presets = [...get().customPresets, preset];
    set({ customPresets: presets, activePresetId: id });
    await persistPresets(presets, id);
  },

  async deletePreset(id) {
    const presets = get().customPresets.filter((p) => p.id !== id);
    const activeId = get().activePresetId === id ? null : get().activePresetId;
    set({ customPresets: presets, activePresetId: activeId });
    await persistPresets(presets, activeId);
  },

  async renamePreset(id, name) {
    const presets = get().customPresets.map((p) =>
      p.id === id ? { ...p, name } : p,
    );
    set({ customPresets: presets });
    await persistPresets(presets, get().activePresetId);
  },

  /* ── Layout lock ── */

  layoutLocked: false,

  toggleLayoutLock() {
    const next = !get().layoutLocked;
    const api = get().dockviewApi;
    if (api) {
      for (const group of api.groups) {
        group.locked = next ? true : false;
      }
      api.updateOptions({ disableDnd: next });
    }
    set({ layoutLocked: next });
  },

  /* ── Reset ── */

  async resetToDefaultLayout() {
    const api = get().dockviewApi;
    if (!api) return;
    const builtin = getBuiltinPreset("builtin:default");
    if (!builtin) return;
    clearLayout(api);
    builtin.build(api);
    set({ activePresetId: "builtin:default" });
    await clearSavedLayout();
    await persistActivePresetId("builtin:default");
  },
}));

/* ── Persistence helpers ── */

async function persistActivePresetId(id: string | null) {
  try {
    const current = await invoke<GlobalSettings>("get_global_settings");
    await invoke("save_global_settings", {
      settings: { ...current, activeLayoutPresetId: id },
    });
  } catch {
    // Ignore
  }
}

async function persistPresets(
  presets: CustomPreset[],
  activeId: string | null,
) {
  try {
    const current = await invoke<GlobalSettings>("get_global_settings");
    await invoke("save_global_settings", {
      settings: {
        ...current,
        layoutPresets: presets,
        activeLayoutPresetId: activeId,
      },
    });
  } catch {
    // Ignore
  }
}

/** Remove the persisted layout from global settings (leaves other settings intact) */
export async function clearSavedLayout() {
  try {
    const current = await invoke<GlobalSettings & { layout?: unknown }>(
      "get_global_settings",
    );
    const settings: GlobalSettings & { layout?: unknown } = { ...current };
    delete settings.layout;
    await invoke("save_global_settings", { settings });
  } catch {
    // Ignore
  }
}
