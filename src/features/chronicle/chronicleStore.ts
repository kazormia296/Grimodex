import { create } from "zustand";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
import { hasExternalEditConflictForStateKey } from "@/lib/externalEditConflictRegistry";
import { isSceneEventId, sceneIdFromEventId } from "./sceneEventAdapter";
import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";

export type ChronicleAxisMode = "calendar" | "sequence";

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
  /**
   * 永続 view が属する座標ドメイン。null は axisMode 導入前の legacy 値で、
   * 次回 Chronicle 表示時に一度だけ現在モードへ再フィットして移行する。
   */
  axisMode: ChronicleAxisMode | null;
  /**
   * 永続 view の所有 Project。null は導入前の legacy 値または未設定で、
   * 別 Project の座標を誤って復元しないため現在 Project へ再フィットする。
   */
  viewProjectId: string | null;
  /**
   * 永続 view の所有 Workspace UUID。null は導入前の path owner または未設定。
   */
  viewWorkspaceId: string | null;
  /** 永続 view の所有 Workspace path（UUID導入前の移行判定にも使用）。 */
  viewWorkspacePath: string | null;
  /**
   * 編集ロック。on でグラフ上の直接操作（マーカーのドラッグ移動・期間端の伸縮・
   * D&D による因果エッジ作成・空白のダブルクリック/右クリック作成）を無効化する。
   * インスペクタやレーンガターからの明示的な編集は対象外（誤操作防止が目的）。
   */
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
  /** 永続 view が属する座標ドメイン（null=legacy / 未設定）。 */
  axisMode: ChronicleAxisMode | null;
  /** 永続 view の所有 Project（null=legacy / 未設定）。 */
  viewProjectId: string | null;
  /** 永続 view の所有 Workspace UUID（null=legacy / 未設定）。 */
  viewWorkspaceId: string | null;
  /** 永続 view の所有 Workspace path（UUID導入前の移行判定にも使用）。 */
  viewWorkspacePath: string | null;
  /**
   * 選択中の出来事(events.id)＝プライマリ（最後にクリック＝範囲選択のアンカー）。
   * Inspector が読む（単一選択時のみ詳細編集を出す）。
   */
  selectedEventId: string | null;
  /**
   * 複数選択中の出来事 id 群（プライマリを含む）。Ctrl/⌘=トグル, Shift=範囲。
   * 単一選択時は [selectedEventId]、未選択は []。ephemeral（非永続）。
   */
  selectedEventIds: string[];
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
  setChronicleView: (
    pxPerDay: number,
    viewStartDay: number,
    axisMode: ChronicleAxisMode,
    viewProjectId: string,
    viewWorkspaceId: string,
    viewWorkspacePath: string,
  ) => void;
  toggleShowOffpage: () => void;
  /** 単一選択（複数選択も [id] に畳む）。null で全解除。 */
  setSelectedEventId: (id: string | null) => void;
  /** 複数選択を明示設定（ids=選択集合・primary=アンカー/Inspector 対象）。 */
  setSelection: (ids: string[], primary: string | null) => void;
  /**
   * 選択集合を実在する出来事 id に整合させる（削除/undo/redo 後の stale 除去）。
   * ロード effect から呼ぶ。変化が無ければ参照を保ち再レンダを避ける。
   */
  sanitizeSelection: (existing: Set<string>) => void;
  toggleLock: () => void;
  /** 位置選択を設定/解除する（空白クリック=設定、選択解除=null）。 */
  setSelectedPosition: (day: number | null, laneKey?: string | null) => void;
  /**
   * ephemeral な選択状態（primary/複数選択/位置/レーン）を全解除する。
   * プロジェクト切替（reloadProjectData）から呼び、旧プロジェクトの
   * selectedEventId が新プロジェクトの renderEvents に stale 一致して
   * 誤選択・クロスプロジェクト参照を生むのを防ぐ。timeline/grid の
   * clearSelection と対になる（従来 chronicle だけ未実装だった）。
   */
  clearSelection: () => void;
  /** 年表 mutation 後に呼ぶ。全 CRUD 経路から発火させる。 */
  bumpRevision: () => void;
  loadFromSettings: (settings: Partial<ChronicleSettings>) => void;
}

function chronicleSelectionDocumentKey(id: string): DocumentKey {
  return isSceneEventId(id)
    ? {
        kind: "tree",
        id: sceneIdFromEventId(id),
        storage: "database",
      }
    : { kind: "chronicle-event", id };
}

function selectionOwnsExternalConflict(id: string | null): boolean {
  if (!id) return false;
  return hasExternalEditConflictForStateKey(
    encodeDocumentKey(chronicleSelectionDocumentKey(id)),
  );
}

export const useChronicleStore = create<ChronicleState>((set, get) => ({
  zoom: 1,
  scrollOffset: 0,
  showOffpage: true,
  pxPerDay: null,
  viewStartDay: null,
  axisMode: null,
  viewProjectId: null,
  viewWorkspaceId: null,
  viewWorkspacePath: null,
  selectedEventId: null,
  selectedEventIds: [],
  locked: false,
  selectedDay: null,
  selectedLaneKey: null,
  revisionCounter: 0,
  setZoom: (zoom) => set({ zoom: clampZoom(zoom) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  setChronicleView: (
    pxPerDay,
    viewStartDay,
    axisMode,
    viewProjectId,
    viewWorkspaceId,
    viewWorkspacePath,
  ) =>
    set({
      pxPerDay,
      viewStartDay,
      axisMode,
      viewProjectId,
      viewWorkspaceId,
      viewWorkspacePath,
    }),
  toggleShowOffpage: () => set((s) => ({ showOffpage: !s.showOffpage })),
  setSelectedEventId: (selectedEventId) => {
    const current = get().selectedEventId;
    if (selectedEventId !== current && selectionOwnsExternalConflict(current)) {
      return;
    }
    set({
      selectedEventId,
      selectedEventIds: selectedEventId ? [selectedEventId] : [],
    });
  },
  setSelection: (selectedEventIds, primary) => {
    const current = get().selectedEventId;
    if (primary !== current && selectionOwnsExternalConflict(current)) return;
    set({ selectedEventIds, selectedEventId: primary });
  },
  sanitizeSelection: (existing) =>
    set((s) => {
      // External deletion can remove the selected row before its dirty draft
      // resolves. Keep the inspector owner mounted so Reload can explicitly
      // discard that draft; otherwise a paused retired AutoSave has no UI left.
      if (
        s.selectedEventId &&
        !existing.has(s.selectedEventId) &&
        selectionOwnsExternalConflict(s.selectedEventId)
      ) {
        return {};
      }
      const ids = s.selectedEventIds.filter((id) => existing.has(id));
      // 何も落ちなければ参照を据え置き（無駄な再レンダ回避）。
      if (ids.length === s.selectedEventIds.length) return {};
      const primary =
        s.selectedEventId && existing.has(s.selectedEventId)
          ? s.selectedEventId
          : (ids[ids.length - 1] ?? null);
      return { selectedEventIds: ids, selectedEventId: primary };
    }),
  toggleLock: () => set((s) => ({ locked: !s.locked })),
  setSelectedPosition: (selectedDay, selectedLaneKey = null) =>
    set({ selectedDay, selectedLaneKey }),
  clearSelection: () =>
    set({
      selectedEventId: null,
      selectedEventIds: [],
      selectedDay: null,
      selectedLaneKey: null,
    }),
  bumpRevision: () => set((s) => ({ revisionCounter: s.revisionCounter + 1 })),
  loadFromSettings: (settings) =>
    set({
      zoom: clampZoom(settings.zoom ?? 1),
      scrollOffset: settings.scrollOffset ?? 0,
      showOffpage: settings.showOffpage ?? true,
      pxPerDay: settings.pxPerDay ?? null,
      viewStartDay: settings.viewStartDay ?? null,
      axisMode:
        settings.axisMode === "calendar" || settings.axisMode === "sequence"
          ? settings.axisMode
          : null,
      viewProjectId:
        typeof settings.viewProjectId === "string"
          ? settings.viewProjectId
          : null,
      viewWorkspaceId:
        typeof settings.viewWorkspaceId === "string"
          ? settings.viewWorkspaceId
          : null,
      viewWorkspacePath:
        typeof settings.viewWorkspacePath === "string"
          ? settings.viewWorkspacePath
          : null,
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
    axisMode: state.axisMode,
    viewProjectId: state.viewProjectId,
    viewWorkspaceId: state.viewWorkspaceId,
    viewWorkspacePath: state.viewWorkspacePath,
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
      await globalSettingsRepository.patch((current) => ({
        ...current,
        chronicle: next,
      }));
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
