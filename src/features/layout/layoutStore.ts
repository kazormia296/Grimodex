import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { DockviewApi, SerializedDockview } from "dockview-react";
import type { GlobalSettings } from "@/features/workspace/store";
import {
  getBuiltinPreset,
  clearLayout,
  type CustomPreset,
} from "./layoutPresets";

export type PanelId =
  | "scenes"
  | "codex"
  | "chat-history"
  | "editor"
  | "chat"
  | "snippets"
  | "attribution"
  | "codex-quick";

/** Human-readable panel titles */
export const PANEL_TITLES: Record<PanelId, string> = {
  scenes: "シーン",
  codex: "Codex",
  "chat-history": "チャット履歴",
  editor: "エディタ",
  chat: "チャット",
  snippets: "Snippets",
  attribution: "帰属",
  "codex-quick": "Codex Quick",
};

interface LayoutState {
  /** Dockview API reference — set once in onReady */
  dockviewApi: DockviewApi | null;
  setDockviewApi: (api: DockviewApi) => void;

  /** Toggle a panel: if visible & active → close it; otherwise → show & focus */
  togglePanel: (panel: PanelId) => void;

  /** Check whether a panel exists in the current layout */
  isPanelVisible: (panel: PanelId) => boolean;

  /** Load persisted layout from global settings; returns the serialized data or null */
  loadLayout: () => Promise<SerializedDockview | null>;
  /** Save current layout to global settings (debounced internally) */
  saveLayout: () => void;

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
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(get: () => LayoutState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const api = get().dockviewApi;
    if (!api) return;
    try {
      const layout = api.toJSON();
      const current = await invoke<GlobalSettings>("get_global_settings");
      await invoke("save_global_settings", {
        settings: { ...current, layout },
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
      try {
        api.fromJSON(custom.layout);
        set({ activePresetId: id });
        persistActivePresetId(id);
      } catch {
        // Corrupted preset — ignore
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
}));

/**
 * Add a panel back to the layout at a sensible default position.
 */
function addPanelWithDefaults(api: DockviewApi, panelId: PanelId) {
  const title = PANEL_TITLES[panelId];

  // Try to group with a sibling panel, or fall back to a directional position
  switch (panelId) {
    case "codex-quick": {
      // Default: below scenes; fall back to left side
      const scenes = api.getPanel("scenes");
      if (scenes) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: "scenes", direction: "below" },
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
    case "scenes":
    case "codex": {
      // Left group — find any sibling
      const sibling = findFirstPanel(api, ["scenes", "codex"], panelId);
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
    case "chat-history": {
      // Right group — group with chat if available
      const chat = api.getPanel("chat");
      if (chat) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: "chat", direction: "within" },
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { direction: "right" },
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
    case "snippets": {
      const codex = api.getPanel("codex");
      if (codex) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: "codex", direction: "within" },
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { direction: "below" },
        });
      }
      break;
    }
    case "attribution": {
      const editor = api.getPanel("editor");
      if (editor) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: "editor", direction: "below" },
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { direction: "below" },
        });
      }
      break;
    }
    case "editor": {
      // Editor should always open in center — to the right of left-column
      // panels (scenes/codex/codex-quick) if they exist
      const leftRef = findFirstPanel(
        api,
        ["scenes", "codex", "codex-quick"],
        panelId,
      );
      if (leftRef) {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
          position: { referencePanel: leftRef, direction: "right" },
        });
      } else {
        api.addPanel({
          id: panelId,
          component: panelId,
          title,
        });
      }
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
