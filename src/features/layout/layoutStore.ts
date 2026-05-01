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
  | "linter"
  | "foreshadow"
  | "grid";

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
  linter: [
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

    // Apply lock state to newly added groups
    api.onDidAddGroup((group) => {
      if (get().layoutLocked) {
        group.locked = true;
      }
    });

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
      if (panel.group?.activePanel === panel) {
        api.removePanel(panel);
      } else {
        panel.api.setActive();
      }
    } else {
      addPanelWithDefaults(api, panelId);
    }
  },

  showPanel(panelId) {
    const api = get().dockviewApi;
    if (!api) return;

    const panel = api.getPanel(panelId);
    if (panel) {
      panel.api.setActive();
    } else {
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

function addPanelWithDefaults(api: DockviewApi, panelId: PanelId) {
  const title = getPanelTitle(panelId);
  const position = resolveInsertPosition(api, panelId);
  api.addPanel({
    id: panelId,
    component: panelId,
    title,
    position,
    ...(panelId === "editor" ? { minimumWidth: 320 } : {}),
  });
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
