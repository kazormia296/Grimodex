import i18next from "i18next";
import {
  buildCenterSegmentsWithTools,
  buildDefaultLayoutState,
  clampLayoutStateForViewport,
  cloneLayoutState,
  redistributeSpaceOnEditorClose,
  removePanelFromSideSlots,
  updateCenter,
} from "./layoutStateUtils";
import { DEFAULT_REGION_SIZES } from "./layoutConstants";
import type { LayoutState, RegionId, ToolWindowPanelId } from "./layoutTypes";

export interface BuiltinPresetMeta {
  id: string;
  name: string;
  builtin: true;
  state: LayoutState;
}

export interface CustomPresetMeta {
  id: string;
  name: string;
  builtin: false;
}

export type LayoutPresetMeta = BuiltinPresetMeta | CustomPresetMeta;

interface PresetDefinition {
  activePanels: Partial<Record<ToolWindowPanelId, boolean>>;
  regionFractions?: Partial<Record<RegionId, number>>;
  editorOpen?: boolean;
  centerToolPanels?: ToolWindowPanelId[];
}

const PRESET_DEFINITIONS: Record<string, PresetDefinition> = {
  "builtin:default": {
    activePanels: { scenes: true, codex: true, chat: true },
  },
  "builtin:plan": {
    activePanels: {
      grid: true,
      timeline: true,
      chat: true,
      codex: true,
    },
    editorOpen: false,
    regionFractions: { left: 0.45, right: 0.35, bottom: 0.17 },
  },
  "builtin:chat-main": {
    activePanels: { chat: true, codex: true },
    regionFractions: { left: 0.45, right: 0.35, bottom: 0.28 },
  },
  "builtin:review": {
    activePanels: {
      scenes: true,
      attribution: true,
      codex: true,
      kouetsu: true,
    },
    centerToolPanels: ["kouetsu", "codex"],
    regionFractions: { left: 0.13, right: 0.35, bottom: 0.28 },
  },
  "builtin:codex-main": {
    activePanels: { codex: true, chat: true },
    regionFractions: { left: 0.45, right: 0.25, bottom: 0.28 },
  },
};

const BUILTIN_IDS = [
  "builtin:default",
  "builtin:plan",
  "builtin:chat-main",
  "builtin:review",
  "builtin:codex-main",
] as const;

const PRESET_I18N_KEYS: Record<(typeof BUILTIN_IDS)[number], string> = {
  "builtin:default": "layout.preset.default",
  "builtin:plan": "layout.preset.plan",
  "builtin:chat-main": "layout.preset.chatMain",
  "builtin:review": "layout.preset.review",
  "builtin:codex-main": "layout.preset.codexMain",
};

export function materializePreset(
  definition: PresetDefinition,
  viewport: { width: number; height: number },
): LayoutState {
  const editorOpen = definition.editorOpen ?? true;
  let state = buildDefaultLayoutState({
    activePanels: definition.activePanels,
    editorOpen,
  });

  const centerToolPanels = definition.centerToolPanels ?? [];
  if (centerToolPanels.length > 0) {
    state = removePanelFromSideSlots(state, centerToolPanels);
    state = updateCenter(state, (center) => ({
      ...center,
      editorOpen,
      segments: buildCenterSegmentsWithTools(
        centerToolPanels,
        definition.activePanels,
      ),
    }));
  } else if (definition.editorOpen != null) {
    state = updateCenter(state, (center) => ({
      ...center,
      editorOpen,
    }));
  }

  if (definition.regionFractions) {
    for (const [region, fraction] of Object.entries(
      definition.regionFractions,
    ) as [RegionId, number][]) {
      const axis = region === "bottom" ? viewport.height : viewport.width;
      state.regions[region].size = Math.round(axis * fraction);
    }
  } else {
    for (const region of ["left", "right", "bottom"] as RegionId[]) {
      state.regions[region].size = DEFAULT_REGION_SIZES[region];
    }
  }

  let result = clampLayoutStateForViewport(state, viewport);

  if (!editorOpen && centerToolPanels.length === 0) {
    result = redistributeSpaceOnEditorClose(result, viewport);
  }

  return result;
}

export function getBuiltinPresetState(
  id: string,
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): LayoutState | undefined {
  const definition = PRESET_DEFINITIONS[id];
  if (!definition) return undefined;
  return materializePreset(definition, viewport);
}

export function getBuiltinPresets(
  viewport: { width: number; height: number } = { width: 1440, height: 900 },
): BuiltinPresetMeta[] {
  return BUILTIN_IDS.map((id) => ({
    id,
    name: i18next.t(PRESET_I18N_KEYS[id]),
    builtin: true as const,
    state: cloneLayoutState(getBuiltinPresetState(id, viewport)!),
  }));
}

export function getBuiltinPreset(id: string): BuiltinPresetMeta | undefined {
  return getBuiltinPresets().find((p) => p.id === id);
}
