import { create } from "zustand";
import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { DockviewApi, SerializedDockview } from "dockview-react";

export type PanelId =
  | "scenes"
  | "codex"
  | "chat-history"
  | "editor"
  | "chat"
  | "snippets"
  | "attribution";

/** Human-readable panel titles */
export const PANEL_TITLES: Record<PanelId, string> = {
  scenes: "シーン",
  codex: "Codex",
  "chat-history": "履歴",
  editor: "エディタ",
  chat: "チャット",
  snippets: "Snippets",
  attribution: "帰属",
};

interface LayoutState {
  /** Dockview API reference — set once in onReady */
  dockviewApi: DockviewApi | null;
  setDockviewApi: (api: DockviewApi) => void;

  /** Toggle a panel: if visible & active → close it; otherwise → show & focus */
  togglePanel: (panel: PanelId) => void;

  /** Check whether a panel exists in the current layout */
  isPanelVisible: (panel: PanelId) => boolean;

  /** Load persisted layout; returns the serialized data or null */
  loadLayout: () => Promise<SerializedDockview | null>;
  /** Save current layout to settings table (debounced internally) */
  saveLayout: () => void;
}

const SETTINGS_KEY = "layout.dockview.v1";
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(get: () => LayoutState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const api = get().dockviewApi;
    if (!api) return;
    const data = api.toJSON();
    const value = JSON.stringify(data);
    db.insert(settings)
      .values({ key: SETTINGS_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .catch(() => {});
  }, 500);
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  dockviewApi: null,

  setDockviewApi(api) {
    set({ dockviewApi: api });

    // Auto-save on any layout change
    api.onDidLayoutChange(() => {
      scheduleSave(get);
    });
  },

  togglePanel(panelId) {
    const api = get().dockviewApi;
    if (!api) return;

    const panel = api.getPanel(panelId);
    if (panel) {
      // Panel exists — if it's the active panel in its group, remove it; otherwise focus it
      if (panel.group?.activePanel === panel) {
        api.removePanel(panel);
      } else {
        panel.api.setActive();
      }
    } else {
      // Panel doesn't exist — add it back with a reasonable position
      addPanelWithDefaults(api, panelId);
    }
  },

  isPanelVisible(panelId) {
    const api = get().dockviewApi;
    if (!api) return false;
    return api.getPanel(panelId) !== undefined;
  },

  async loadLayout() {
    try {
      const rows = await db
        .select()
        .from(settings)
        .where(eq(settings.key, SETTINGS_KEY));
      if (rows.length > 0) {
        return JSON.parse(rows[0].value) as SerializedDockview;
      }
    } catch {
      // Use default layout on error
    }
    return null;
  },

  saveLayout() {
    scheduleSave(get);
  },
}));

/**
 * Add a panel back to the layout at a sensible default position.
 */
function addPanelWithDefaults(api: DockviewApi, panelId: PanelId) {
  const title = PANEL_TITLES[panelId];

  // Try to group with a sibling panel, or fall back to a directional position
  switch (panelId) {
    case "scenes":
    case "codex":
    case "chat-history": {
      // Left group — find any sibling
      const sibling = findFirstPanel(
        api,
        ["scenes", "codex", "chat-history"],
        panelId,
      );
      if (sibling) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: sibling, direction: "within" },
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { direction: "left" },
        });
      }
      break;
    }
    case "chat": {
      api.addPanel({
        id: panelId,
        component: panelId,
        title,
        position: { direction: "right" },
      });
      break;
    }
    case "snippets":
    case "attribution": {
      const sibling = findFirstPanel(api, ["snippets", "attribution"], panelId);
      if (sibling) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: sibling, direction: "within" },
        });
      } else {
        const editor = api.getPanel("editor");
        if (editor) {
          api.addPanel({
            id: panelId,
            component: panelId,
            title,
            position: { referencePanel: editor, direction: "below" },
          });
        } else {
          api.addPanel({
            id: panelId,
            component: panelId,
            title,
            position: { direction: "below" },
          });
        }
      }
      break;
    }
    case "editor": {
      // Editor should always be in center
      api.addPanel({
        id: panelId,
        component: panelId,
        title,
        position: { direction: "right" },
      });
      break;
    }
  }
}

function findFirstPanel(
  api: DockviewApi,
  ids: PanelId[],
  exclude: PanelId,
): string | undefined {
  for (const id of ids) {
    if (id !== exclude && api.getPanel(id)) return id;
  }
  return undefined;
}
