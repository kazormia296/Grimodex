import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

export interface ChronicleSettings {
  zoom: number;
  scrollOffset: number;
  /** オフページ（scene 参照0）の出来事を中空マーカーで表示するか。 */
  showOffpage: boolean;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const clampZoom = (z: number): number =>
  Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface ChronicleState {
  zoom: number;
  scrollOffset: number;
  showOffpage: boolean;
  /** 選択中の出来事(events.id)。Inspector が読む。 */
  selectedEventId: string | null;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  toggleShowOffpage: () => void;
  setSelectedEventId: (id: string | null) => void;
  loadFromSettings: (settings: Partial<ChronicleSettings>) => void;
}

export const useChronicleStore = create<ChronicleState>((set) => ({
  zoom: 1,
  scrollOffset: 0,
  showOffpage: true,
  selectedEventId: null,
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  toggleShowOffpage: () => set((s) => ({ showOffpage: !s.showOffpage })),
  setSelectedEventId: (selectedEventId) => set({ selectedEventId }),
  loadFromSettings: (settings) =>
    set({
      zoom: clampZoom(settings.zoom ?? 1),
      scrollOffset: settings.scrollOffset ?? 0,
      showOffpage: settings.showOffpage ?? true,
    }),
}));

function snapshotPersistent(
  state: ReturnType<typeof useChronicleStore.getState>,
): ChronicleSettings {
  return {
    zoom: state.zoom,
    scrollOffset: state.scrollOffset,
    showOffpage: state.showOffpage,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let prevPersistent = snapshotPersistent(useChronicleStore.getState());

useChronicleStore.subscribe((state) => {
  const next = snapshotPersistent(state);
  if (JSON.stringify(next) === JSON.stringify(prevPersistent)) return;
  prevPersistent = next;

  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const current = await invoke<GlobalSettings>("get_global_settings");
      await invoke("save_global_settings", {
        settings: { ...current, chronicle: next },
      });
    } catch (e) {
      if (import.meta.env.MODE !== "test") {
        console.warn("[chronicle] save failed:", e);
      }
    }
  }, 500);
});

/**
 * 永続化された chronicle 設定をロードし prevPersistent を即同期する。
 * loadFromSettings が誘発する無駄な save-back IPC を打ち消すためこちらを使う。
 */
export function loadAndSyncChronicleSettings(
  settings: Partial<ChronicleSettings>,
) {
  useChronicleStore.getState().loadFromSettings(settings);
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  prevPersistent = snapshotPersistent(useChronicleStore.getState());
}
