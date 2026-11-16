import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import type { OverlayId } from "@/features/layout/layoutTypes";
import type { PanelId } from "@/features/layout/panelIds";

/**
 * 最大化・オーバーレイ・phone の画面（transient な表示状態）を、退避した値へ戻す。
 * 他の feature（UI 操作の「元に戻す」）から layout の store を直接書かないための入口。
 * 最大化中はオーバーレイを開かない（既存の layout の不変条件に合わせる）。
 */
export function restoreTransientUiState(state: {
  maximizedPanelId: PanelId | null;
  openOverlay: OverlayId | null;
  phoneSurface?: { activeSurface: string; backStack: readonly string[] };
}): void {
  useLayoutStore.setState({
    maximizedPanelId: state.maximizedPanelId,
    openOverlay: state.maximizedPanelId === null ? state.openOverlay : null,
  });
  if (state.phoneSurface) {
    useCompactNavigationStore.setState({
      activeSurface: state.phoneSurface.activeSurface,
      backStack: [...state.phoneSurface.backStack],
    });
  }
}
