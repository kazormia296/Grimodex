import { create } from "zustand";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";

export type LeftTab = "scenes" | "codex" | "chat-history";
export type RightTab = "chat";
export type BottomTab = "snippets" | "attribution";
export type PanelId = LeftTab | RightTab | BottomTab;

interface LayoutState {
  /** Active tab in left dock, or null if dock is collapsed */
  leftActive: LeftTab | null;
  /** Active tab in right dock, or null if dock is collapsed */
  rightActive: RightTab | null;
  /** Active tab in bottom dock, or null if dock is hidden */
  bottomActive: BottomTab | null;

  /** Toggle a panel from the Activity Bar */
  togglePanel: (panel: PanelId) => void;
  setLeftActive: (tab: LeftTab) => void;
  setRightActive: (tab: RightTab) => void;
  setBottomActive: (tab: BottomTab) => void;

  /** Load persisted layout from settings table */
  loadLayout: () => Promise<void>;
  /** Save current layout to settings table (debounced internally) */
  _saveLayout: () => Promise<void>;
}

const SETTINGS_KEY = "layout.v1";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(get: () => LayoutState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    get()
      ._saveLayout()
      .catch(() => {});
  }, 500);
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  leftActive: "scenes",
  rightActive: "chat",
  bottomActive: null,

  togglePanel(panel) {
    const { leftActive, rightActive, bottomActive } = get();
    if (panel === "scenes" || panel === "codex" || panel === "chat-history") {
      set({ leftActive: leftActive === panel ? null : panel });
    } else if (panel === "chat") {
      set({ rightActive: rightActive === "chat" ? null : "chat" });
    } else if (panel === "snippets" || panel === "attribution") {
      set({ bottomActive: bottomActive === panel ? null : panel });
    }
    scheduleSave(get);
  },

  setLeftActive(tab) {
    set({ leftActive: tab });
    scheduleSave(get);
  },

  setRightActive(tab) {
    set({ rightActive: tab });
    scheduleSave(get);
  },

  setBottomActive(tab) {
    set({ bottomActive: tab });
    scheduleSave(get);
  },

  async loadLayout() {
    try {
      const rows = await db
        .select()
        .from(settings)
        .where(eq(settings.key, SETTINGS_KEY));
      if (rows.length > 0) {
        const saved = JSON.parse(rows[0].value) as Partial<{
          leftActive: LeftTab | null;
          rightActive: RightTab | null;
          bottomActive: BottomTab | null;
        }>;
        set({
          leftActive: saved.leftActive ?? "scenes",
          rightActive: saved.rightActive ?? "chat",
          bottomActive: saved.bottomActive ?? null,
        });
      }
    } catch {
      // Use defaults on error
    }
  },

  async _saveLayout() {
    const { leftActive, rightActive, bottomActive } = get();
    const value = JSON.stringify({ leftActive, rightActive, bottomActive });
    try {
      await db
        .insert(settings)
        .values({ key: SETTINGS_KEY, value })
        .onConflictDoUpdate({ target: settings.key, set: { value } });
    } catch {
      // Ignore save errors silently
    }
  },
}));
