/**
 * `get_ui_state` が返す、今の UI 状態の写し。
 *
 * 返すものは allowlist で組み立てる（下の `readUiState` のオブジェクトリテラルに書いた項目だけ）。
 * store や DOM を丸ごと広げて返さない。本文・秘密・API key・endpoint・provider の設定は含めない。
 * シーンは ID と題だけ。
 *
 * 画面の状態のうち store に無いもの（Settings の開閉、phone 幅か、フォーカス中のパネル）は、
 * 既存の DOM の印を読む。印が無いときは推測せず null（不明）で返す。
 */
import type { PanelId } from "@/features/layout/panelIds";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  allPanelIds,
  builtinPresetName,
  panelTitle,
  settingsCategoryList,
} from "./helpCatalog";

export interface UiPanelRef {
  id: PanelId;
  title: string;
}

export interface UiStateSnapshot {
  /** パネルを切り出した別ウィンドウか。そうなら配置と Settings の項目は主画面の状態でないので null */
  isPanelWindow: boolean;
  /** 窓幅の区分。DOM の印（data-viewport-profile）が無いとき null */
  viewportProfile: "wide" | "compact" | "phone" | null;
  /** 狭い画面（phone 幅）か。不明なとき null */
  isPhoneWidth: boolean | null;
  /** phone 幅のときに表示中の画面（editor／scenes／codex／ai／more／search 等）。phone でなければ null */
  phoneSurface: string | null;
  /** 表示中のパネル。phone 幅では配置が表示に使われないので null */
  openPanels: UiPanelRef[] | null;
  /** フォーカスがあるパネル。判別できないとき null */
  focusedPanel: UiPanelRef | null;
  /** 適用中のレイアウトプリセット。無ければ null */
  layoutPreset: { id: string; name: string | null; builtin: boolean } | null;
  /** 最大化（zoom）中のパネル */
  maximizedPanel: UiPanelRef | null;
  /** 開いているオーバーレイ */
  openOverlay: "left" | "right" | null;
  layoutLocked: boolean | null;
  settings: {
    /** Settings 画面が開いているか。不明なとき null */
    open: boolean | null;
    /** 開いているときの表示中カテゴリ */
    category: string | null;
  };
  /** 今のシーン。ID と題だけ（本文は含めない） */
  activeScene: { id: string; title: string } | null;
}

const VIEWPORT_PROFILES = ["wide", "compact", "phone"] as const;

function panelRef(id: PanelId): UiPanelRef {
  return { id, title: panelTitle(id) };
}

function asPanelId(value: string | null | undefined): PanelId | null {
  return allPanelIds().find((id) => id === value) ?? null;
}

function readFocusedPanel(root: Document): PanelId | null {
  const active = root.activeElement;
  if (!active || typeof active.closest !== "function") return null;
  const slot = active.closest("[data-slot-panel]");
  if (slot) return asPanelId(slot.getAttribute("data-slot-panel"));
  // ダイアログ内の入力欄は、エディタとして数えない。
  if (active.closest('[role="dialog"]')) return null;
  if (active.closest(".ProseMirror")) return "editor";
  return null;
}

export function readUiState(
  root: Document | null = typeof document === "undefined" ? null : document,
): UiStateSnapshot {
  const layout = useLayoutStore.getState();
  // 別ウィンドウの配置は主画面のものではない。断定せず null で返す。
  const panelWindow = isPanelWindow();

  const shell = root?.querySelector("[data-viewport-profile]") ?? null;
  const profileAttr = shell?.getAttribute("data-viewport-profile");
  const viewportProfile =
    VIEWPORT_PROFILES.find((profile) => profile === profileAttr) ?? null;
  const isPhoneWidth =
    viewportProfile === null ? null : viewportProfile === "phone";

  const settingsContent =
    root?.querySelector("[data-settings-category]") ?? null;
  const categoryAttr = settingsContent?.getAttribute("data-settings-category");
  const settingsCategory =
    settingsCategoryList().find((category) => category.id === categoryAttr)
      ?.id ?? null;

  let layoutPreset: UiStateSnapshot["layoutPreset"] = null;
  if (layout.activePresetId !== null) {
    const builtinName = builtinPresetName(layout.activePresetId);
    const custom = layout.customPresets.find(
      (preset) => preset.id === layout.activePresetId,
    );
    layoutPreset = {
      id: layout.activePresetId,
      name: builtinName ?? custom?.name ?? null,
      builtin: builtinName !== null,
    };
  }

  const focusedPanelId = root ? readFocusedPanel(root) : null;

  const tree = useTreeStore.getState();
  const sceneNode =
    tree.activeSceneId === ""
      ? undefined
      : tree.nodes.find((node) => node.id === tree.activeSceneId);

  return {
    isPanelWindow: panelWindow,
    viewportProfile,
    isPhoneWidth,
    phoneSurface:
      isPhoneWidth === true
        ? useCompactNavigationStore.getState().activeSurface
        : null,
    openPanels:
      isPhoneWidth === true || panelWindow
        ? null
        : allPanelIds()
            .filter((id) => layout.isPanelActive(id))
            .map(panelRef),
    focusedPanel: focusedPanelId ? panelRef(focusedPanelId) : null,
    layoutPreset: panelWindow ? null : layoutPreset,
    maximizedPanel:
      layout.maximizedPanelId && !panelWindow
        ? panelRef(layout.maximizedPanelId)
        : null,
    openOverlay: panelWindow ? null : layout.openOverlay,
    layoutLocked: panelWindow ? null : layout.layoutLocked,
    settings: {
      open: shell === null || panelWindow ? null : settingsContent !== null,
      category: settingsCategory,
    },
    activeScene: sceneNode
      ? { id: sceneNode.id, title: sceneNode.title }
      : null,
  };
}
