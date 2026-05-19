import type { KeyboardEvent } from "react";
import {
  barVisibleFlat,
  selectPopoverOpen,
  useCommandCenterStore,
} from "../store/commandCenterStore";

/**
 * 検索バーの input に bind する onKeyDown ハンドラ。
 * popover open 時のみ ↑↓ Enter を preventDefault してリスト操作に振り向ける。
 * popover 閉鎖時の ↑↓ はキャレット移動 (input のデフォルト挙動) を維持する。
 *
 * Escape は popover open 状態に関わらず常に `open=false`。フォーカス維持。
 */
export function handleCommandCenterKeyDown(
  e: KeyboardEvent<HTMLInputElement>,
): void {
  const state = useCommandCenterStore.getState();

  if (e.key === "Escape") {
    if (state.open) {
      e.preventDefault();
      state.setOpen(false);
    }
    return;
  }

  const popoverOpen = selectPopoverOpen(state);
  if (!popoverOpen) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.moveSelection("down");
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    state.moveSelection("up");
    return;
  }
  if (e.key === "Enter") {
    const hasItems = barVisibleFlat(state.sections).length > 0;
    if (hasItems) {
      e.preventDefault();
      state.executeSelected();
    }
  }
}
