import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import { recordLayoutSnapshot } from "@/features/timelapse/captureLayout";
import { resolveViewportProfile } from "@/runtime/viewportProfile";
import { cloneLayoutState, validateLayoutState } from "./layoutStateUtils";
import {
  type BuiltinPresetOverride,
  type CustomLayoutPreset,
  LAYOUT_SCHEMA_VERSION,
  type LayoutState,
  type PersistedLayout,
  type ToolWindowPanelId,
} from "./layoutTypes";
import { isBuiltinPresetId, type BuiltinPresetId } from "./layoutPresets";

export interface LayoutPersistenceSnapshot {
  layout: LayoutState;
  activePresetId: string | null;
  customPresets: CustomLayoutPreset[];
  builtinPresetOverrides: Partial<
    Record<BuiltinPresetId, BuiltinPresetOverride>
  >;
  hiddenStripePanels: Set<ToolWindowPanelId>;
}

export function serializeBuiltinOverrides(
  overrides: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
): GlobalSettings["builtinLayoutPresetOverrides"] {
  const entries = Object.entries(overrides).filter(
    ([id, override]) => isBuiltinPresetId(id) && override != null,
  ) as [BuiltinPresetId, BuiltinPresetOverride][];
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([id, override]) => [
      id,
      {
        state: override.state,
        hiddenStripePanels: override.hiddenStripePanels,
      },
    ]),
  );
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSave(
  get: () => LayoutPersistenceSnapshot,
  getViewport: () => { width: number; height: number },
): void {
  const scheduledViewport = getViewport();
  if (resolveViewportProfile(scheduledViewport.width) === "phone") {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return;
  }

  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const currentViewport = getViewport();
    if (resolveViewportProfile(currentViewport.width) === "phone") return;

    try {
      const {
        layout,
        activePresetId,
        customPresets,
        builtinPresetOverrides,
        hiddenStripePanels,
      } = get();
      if (!validateLayoutState(layout, { viewport: currentViewport }).valid)
        return;

      recordLayoutSnapshot({
        layout: cloneLayoutState(layout),
        activePresetId,
        hiddenStripePanels:
          hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
      });
      const persisted: PersistedLayout = {
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        state: cloneLayoutState(layout),
        activePresetId: activePresetId ?? undefined,
        hiddenStripePanels:
          hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
      };
      await globalSettingsRepository.patch((current) => ({
        ...current,
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        layout: persisted,
        activeLayoutPresetId: activePresetId ?? null,
        layoutPresets: customPresets.map((preset) => ({
          id: preset.id,
          name: preset.name,
          state: preset.state,
          hiddenStripePanels: preset.hiddenStripePanels,
        })),
        builtinLayoutPresetOverrides: serializeBuiltinOverrides(
          builtinPresetOverrides,
        ),
      }));
    } catch {
      /* Persistence is best-effort; the in-memory layout remains authoritative. */
    }
  }, 500);
}

export async function persistPresets(
  presets: CustomLayoutPreset[],
  activeId: string | null,
  builtinOverrides?: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
): Promise<void> {
  try {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      layoutPresets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        state: preset.state,
        hiddenStripePanels: preset.hiddenStripePanels,
      })),
      activeLayoutPresetId: activeId,
      ...(builtinOverrides !== undefined
        ? {
            builtinLayoutPresetOverrides:
              serializeBuiltinOverrides(builtinOverrides),
          }
        : {}),
    }));
  } catch {
    /* ignore */
  }
}

export async function persistBuiltinOverrides(
  overrides: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
): Promise<void> {
  try {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      builtinLayoutPresetOverrides: serializeBuiltinOverrides(overrides),
    }));
  } catch {
    /* ignore */
  }
}
