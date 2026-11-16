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
 *
 * 後の変更を巻き戻さないために、退避には操作の直後の写し（after）と登録時の phone 幅かどうかも持たせる。
 * 「元に戻す」を押した時点の状態が after と違う（利用者や別の操作が後で配置を変えた）か、画面の幅の
 * profile が変わっていたときは、何も変えずに failed を返す（理由は entry.failure に残す）。
 */
import { create } from "zustand";
import { getRegisteredCommandContext } from "@/features/commands/commandContext";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import {
  applyValidatedLayout,
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

/** 配置は不変更新なので参照が同じなら同じ。違うときだけ中身を比べる（再 clamp などの参照だけの差し替えを変更とみなさない）。 */
function layoutsEqual(a: UiOperationSnapshot, b: UiOperationSnapshot) {
  if (a.layout === b.layout) return true;
  try {
    return JSON.stringify(a.layout) === JSON.stringify(b.layout);
  } catch {
    return false;
  }
}

/**
 * 今の状態が、操作の後に変わっているか（後の手作業を巻き戻さないための判定）。
 * 配置・プリセット・非表示の Stripe は `after` と厳密に比べる。
 * 最大化・overlay・phone の画面は transient で、押す前に自然に変わる（overlay は ボタンの pointerdown で
 * 閉じ、phone ではボタンのある画面へ戻っている）ので、今の値が `after` と同じ、または操作前（`snapshot`）と
 * 同じなら変更とみなさない（戻す向きへの変化は後の手作業ではない）。
 */
export function uiStateChangedSince(
  after: UiOperationSnapshot,
  snapshot: UiOperationSnapshot,
  current: UiOperationSnapshot = captureUiSnapshot(),
): boolean {
  const transientChanged = <K extends keyof UiOperationSnapshot>(key: K) =>
    current[key] !== after[key] && current[key] !== snapshot[key];
  return (
    !layoutsEqual(after, current) ||
    after.activePresetId !== current.activePresetId ||
    !setsEqual(after.hiddenStripePanels, current.hiddenStripePanels) ||
    transientChanged("maximizedPanelId") ||
    transientChanged("openOverlay") ||
    transientChanged("phoneSurface")
  );
}

/** 今が phone 幅の workspace か（host の文脈。host が無ければ false）。 */
function currentPhoneWorkspace(): boolean {
  return getRegisteredCommandContext()?.phoneWorkspace ?? false;
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
    // 今の画面で写しの配置が有効でないとき（幅の変化など）は、何も変えずに棄却する。
    // restoreViewportBaseline は棄却しても preset id などを先に差し替えるので、事前に確かめる。
    if (
      applyValidatedLayout(snapshot.layout, current.layout) === current.layout
    ) {
      return "failed";
    }
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

/**
 * 戻せなかった理由（card に出す）。viewport＝登録のときと画面の幅の profile（phone か否か）が違う、
 * changed＝操作の後に配置が変わった、layout＝写しの配置を今の画面で復元できない。
 */
export type UiUndoFailure = "viewport" | "changed" | "layout";

interface UiUndoEntry {
  snapshot: UiOperationSnapshot;
  /** 操作の直後の写し。これと今が違えば、後の変更を巻き戻さないよう戻さない。 */
  after: UiOperationSnapshot;
  /** 登録のときに phone 幅だったか。 */
  phoneWorkspace: boolean;
  status: UiUndoStatus;
  seq: number;
  /** 直近の戻しが failed だったときの理由。 */
  failure?: UiUndoFailure;
}

/** 退避を持つ操作の数の上限（古いものから捨てる）。 */
const MAX_UNDO_ENTRIES = 20;

interface UiUndoState {
  entries: Record<string, UiUndoEntry>;
  /** 操作の直前（snapshot）と直後（after）の写しを登録して、chat の tool 結果に載せる id を返す。 */
  register: (
    snapshot: UiOperationSnapshot,
    after: UiOperationSnapshot,
  ) => string;
  /**
   * 戻した結果。unavailable＝id が無い／すでに戻した／後の操作で無効、blocked＝inline AI の
   * 未確定の結果があり今は戻せない、failed＝画面の幅が変わった・操作の後に配置が変わった・
   * 写しの配置を今の画面で復元できなかった（理由は entry.failure。どれも何も変えない）。
   */
  undo: (id: string) => "restored" | "unavailable" | "blocked" | "failed";
}

let seqCounter = 0;

export const useUiUndoStore = create<UiUndoState>((set, get) => ({
  entries: {},
  register: (snapshot, after) => {
    const id = crypto.randomUUID();
    seqCounter += 1;
    set((state) => {
      const entries = {
        ...state.entries,
        [id]: {
          snapshot,
          after,
          phoneWorkspace: currentPhoneWorkspace(),
          status: "available" as const,
          seq: seqCounter,
        },
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
    const fail = (failure: UiUndoFailure) => {
      set((state) => ({
        entries: { ...state.entries, [id]: { ...entry, failure } },
      }));
      return "failed" as const;
    };
    // 幅の profile が違うと、写しの配置・phone の画面がそのまま使えない。
    if (entry.phoneWorkspace !== currentPhoneWorkspace()) {
      return fail("viewport");
    }
    // 操作の後に配置が変わっているなら、後の変更（利用者の手作業を含む）を巻き戻さない。
    if (uiStateChangedSince(entry.after, entry.snapshot))
      return fail("changed");
    const restored = restoreUiSnapshot(entry.snapshot);
    if (restored === "failed") return fail("layout");
    if (restored !== "restored") return restored;
    set((state) => {
      const entries = { ...state.entries };
      for (const [otherId, other] of Object.entries(entries)) {
        if (otherId === id) {
          entries[otherId] = { ...other, status: "undone", failure: undefined };
        } else if (other.seq > entry.seq && other.status === "available") {
          entries[otherId] = { ...other, status: "superseded" };
        }
      }
      return { entries };
    });
    return "restored";
  },
}));
