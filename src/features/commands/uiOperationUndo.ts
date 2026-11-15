/**
 * agent の UI 操作（run_app_command／apply_layout_preset）を 1 回で元に戻すための退避。
 *
 * 退避するのは layout store の表示状態（配置・プリセット・非表示の Stripe・最大化・オーバーレイ）と、
 * phone 幅の画面切替だけ。tab の分割・切替や Settings の開閉は含まない（それらは「元に戻せる」と
 * 言わない。呼び出し側は `uiSnapshotsDiffer` が true のときだけ undo を登録する）。
 *
 * 退避はメモリ上だけ。chat の tool 結果（ToolCallRecord）は message metadata として DB に保存されるが、
 * 保存するのは `undoId` だけで、配置の写しは保存しない。再読込・再起動後は「元に戻す」は出ない。
 * 戻せるのは 1 回だけで、先の操作を戻すと、それより後の操作の退避は無効にする（古い配置で上書きしない）。
 */
import { create } from "zustand";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import {
  useLayoutStore,
  type LayoutViewportBaseline,
} from "@/features/layout/layoutStore";
import type { OverlayId } from "@/features/layout/layoutTypes";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";

export interface UiOperationSnapshot extends LayoutViewportBaseline {
  openOverlay: OverlayId | null;
  phoneSurface: string;
  phoneBackStack: readonly string[];
}

/** 操作の直前（と直後）の表示状態を写す。layout は不変更新なので参照を持つだけでよい。 */
export function captureUiSnapshot(): UiOperationSnapshot {
  const layout = useLayoutStore.getState();
  const compact = useCompactNavigationStore.getState();
  return {
    layout: layout.layout,
    activePresetId: layout.activePresetId,
    hiddenStripePanels: layout.hiddenStripePanels,
    maximizedPanelId: layout.maximizedPanelId,
    openOverlay: layout.openOverlay,
    phoneSurface: compact.activeSurface,
    phoneBackStack: compact.backStack,
  };
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function layoutPartDiffers(
  a: UiOperationSnapshot,
  b: UiOperationSnapshot,
): boolean {
  return (
    a.layout !== b.layout ||
    a.activePresetId !== b.activePresetId ||
    !setsEqual(a.hiddenStripePanels, b.hiddenStripePanels)
  );
}

/** 2 つの写しが「元に戻す」で区別できる違いを持つか。 */
export function uiSnapshotsDiffer(
  a: UiOperationSnapshot,
  b: UiOperationSnapshot,
): boolean {
  return (
    layoutPartDiffers(a, b) ||
    a.maximizedPanelId !== b.maximizedPanelId ||
    a.openOverlay !== b.openOverlay ||
    a.phoneSurface !== b.phoneSurface
  );
}

/**
 * 写しの状態へ戻す。inline AI が pending のときは本文を守るため戻さず "blocked"
 * （配置の差し替えで editor が消える経路があるため）。画面幅の変化などで写しの配置が
 * 今は有効でなく、store が差し替えを棄却したときは "failed"（配置は変わらない）。
 */
export function restoreUiSnapshot(
  snapshot: UiOperationSnapshot,
): "restored" | "blocked" | "failed" {
  const layout = useLayoutStore.getState();
  const current = captureUiSnapshot();
  if (layoutPartDiffers(current, snapshot)) {
    if (guardInlineAiPending()) return "blocked";
    try {
      layout.restoreViewportBaseline({
        layout: snapshot.layout,
        activePresetId: snapshot.activePresetId,
        hiddenStripePanels: snapshot.hiddenStripePanels,
        maximizedPanelId: snapshot.maximizedPanelId,
      });
    } catch {
      return "failed";
    }
    // 差し替えが棄却されると、store は今の layout を返す（同じ参照のまま）。
    if (useLayoutStore.getState().layout === current.layout) return "failed";
  }
  // 最大化とオーバーレイは transient。layout を差し替えると購読側が閉じるので、その後に戻す。
  useLayoutStore.setState({
    maximizedPanelId: snapshot.maximizedPanelId,
    openOverlay:
      snapshot.maximizedPanelId === null ? snapshot.openOverlay : null,
  });
  if (current.phoneSurface !== snapshot.phoneSurface) {
    useCompactNavigationStore.setState({
      activeSurface: snapshot.phoneSurface,
      backStack: [...snapshot.phoneBackStack],
    });
  }
  return "restored";
}

export type UiUndoStatus = "available" | "undone" | "superseded";

interface UiUndoEntry {
  snapshot: UiOperationSnapshot;
  status: UiUndoStatus;
  seq: number;
}

/** 退避を持つ操作の数の上限（古いものから捨てる）。 */
const MAX_UNDO_ENTRIES = 20;

interface UiUndoState {
  entries: Record<string, UiUndoEntry>;
  /** 操作の直前の写しを登録して、chat の tool 結果に載せる id を返す。 */
  register: (snapshot: UiOperationSnapshot) => string;
  /**
   * 戻した結果。unavailable＝id が無い／すでに戻した／後の操作で無効、blocked＝inline AI の
   * 未確定の結果があり今は戻せない、failed＝写しの配置を今の画面で復元できなかった。
   */
  undo: (id: string) => "restored" | "unavailable" | "blocked" | "failed";
}

let seqCounter = 0;

export const useUiUndoStore = create<UiUndoState>((set, get) => ({
  entries: {},
  register: (snapshot) => {
    const id = crypto.randomUUID();
    seqCounter += 1;
    set((state) => {
      const entries = {
        ...state.entries,
        [id]: { snapshot, status: "available" as const, seq: seqCounter },
      };
      const ids = Object.keys(entries);
      if (ids.length > MAX_UNDO_ENTRIES) {
        ids
          .sort((a, b) => entries[a]!.seq - entries[b]!.seq)
          .slice(0, ids.length - MAX_UNDO_ENTRIES)
          .forEach((oldId) => delete entries[oldId]);
      }
      return { entries };
    });
    return id;
  },
  undo: (id) => {
    const entry = get().entries[id];
    if (!entry || entry.status !== "available") return "unavailable";
    const restored = restoreUiSnapshot(entry.snapshot);
    if (restored !== "restored") return restored;
    set((state) => {
      const entries = { ...state.entries };
      for (const [otherId, other] of Object.entries(entries)) {
        if (otherId === id) {
          entries[otherId] = { ...other, status: "undone" };
        } else if (other.seq > entry.seq && other.status === "available") {
          entries[otherId] = { ...other, status: "superseded" };
        }
      }
      return { entries };
    });
    return "restored";
  },
}));
