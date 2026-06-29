import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

export interface ChronicleSettings {
  zoom: number;
  scrollOffset: number;
  /** オフページ（scene 参照0）の出来事を中空マーカーで表示するか。 */
  showOffpage: boolean;
  /**
   * pan/zoom ビューの永続値（日番号タイムライン）。null=未設定（初回は全体に
   * フィット）。ユーザーがパン/ズームした時点で値が入り、再オープン時に復元する。
   */
  pxPerDay: number | null;
  viewStartDay: number | null;
  /** 編集ロック。on でドラッグ移動・作成・端伸縮・因果エッジ作成を無効化。 */
  locked: boolean;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const clampZoom = (z: number): number =>
  Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface ChronicleState {
  zoom: number;
  scrollOffset: number;
  showOffpage: boolean;
  /** pan/zoom ビューの永続値（null=未設定＝初回フィット）。 */
  pxPerDay: number | null;
  viewStartDay: number | null;
  /** 選択中の出来事(events.id)。Inspector が読む。 */
  selectedEventId: string | null;
  /** 編集ロック（永続）。 */
  locked: boolean;
  /**
   * 選択中の「位置」（日番号）。空白クリックで設定し、縦ガイドと「新しい出来事」の
   * 作成位置に使う。ephemeral（非永続）。
   */
  selectedDay: number | null;
  /** 選択位置のレーンキー（codexId or "__unassigned" or null）。ephemeral。 */
  selectedLaneKey: string | null;
  /**
   * 年表データが変わるたびに単調増加するカウンタ（session-only・非永続）。
   * AI コンテキストの `contextPromptKey` に join され、年表編集後に preview/送信の
   * stale な lastSystemPrompt 流用を防ぐ（C3 prompt 鮮度）。
   */
  revisionCounter: number;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  /** pan/zoom ビューを永続値へ反映する（drag/zoom/fit の各操作で呼ぶ）。 */
  setChronicleView: (pxPerDay: number, viewStartDay: number) => void;
  toggleShowOffpage: () => void;
  setSelectedEventId: (id: string | null) => void;
  toggleLock: () => void;
  /** 位置選択を設定/解除する（空白クリック=設定、選択解除=null）。 */
  setSelectedPosition: (day: number | null, laneKey?: string | null) => void;
  /** 年表 mutation 後に呼ぶ。全 CRUD 経路から発火させる。 */
  bumpRevision: () => void;
  loadFromSettings: (settings: Partial<ChronicleSettings>) => void;
}

export const useChronicleStore = create<ChronicleState>((set) => ({
  zoom: 1,
  scrollOffset: 0,
  showOffpage: true,
  pxPerDay: null,
  viewStartDay: null,
  selectedEventId: null,
  locked: false,
  selectedDay: null,
  selectedLaneKey: null,
  revisionCounter: 0,
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  setChronicleView: (pxPerDay, viewStartDay) => set({ pxPerDay, viewStartDay }),
  toggleShowOffpage: () => set((s) => ({ showOffpage: !s.showOffpage })),
  setSelectedEventId: (selectedEventId) => set({ selectedEventId }),
  toggleLock: () => set((s) => ({ locked: !s.locked })),
  setSelectedPosition: (selectedDay, selectedLaneKey = null) =>
    set({ selectedDay, selectedLaneKey }),
  bumpRevision: () => set((s) => ({ revisionCounter: s.revisionCounter + 1 })),
  loadFromSettings: (settings) =>
    set({
      zoom: clampZoom(settings.zoom ?? 1),
      scrollOffset: settings.scrollOffset ?? 0,
      showOffpage: settings.showOffpage ?? true,
      pxPerDay: settings.pxPerDay ?? null,
      viewStartDay: settings.viewStartDay ?? null,
      locked: settings.locked ?? false,
    }),
}));

function snapshotPersistent(
  state: ReturnType<typeof useChronicleStore.getState>,
): ChronicleSettings {
  return {
    zoom: state.zoom,
    scrollOffset: state.scrollOffset,
    showOffpage: state.showOffpage,
    pxPerDay: state.pxPerDay,
    viewStartDay: state.viewStartDay,
    locked: state.locked,
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
