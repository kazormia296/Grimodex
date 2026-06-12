import { useTranslation } from "react-i18next";
import { Minimize2 } from "lucide-react";
import { getPanelTitle, useLayoutStore } from "./layoutStore";
import type { PanelId } from "./panelIds";

interface ZoomRestoreBarProps {
  panelId: PanelId;
}

/**
 * 最大化（視覚 zoom）中だけ center stripe 帯に出る復帰バー。
 *
 * zoom 中は stripe が全て不可視になるため、Esc / dblclick / 右クリックという
 * 不可視アフォーダンスだけでは解除手段の発見可能性が足りない。タイトル +
 * 「元のサイズに戻す」ボタンを常時見える位置（通常時の center stripe と
 * 同じ高さの帯）に置く。バー自体のダブルクリックでも解除する（タイトル
 * バー慣習との一貫性）。
 */
export function ZoomRestoreBar({ panelId }: ZoomRestoreBarProps) {
  const { t } = useTranslation();
  const clearMaximize = useLayoutStore((s) => s.clearMaximize);

  return (
    <div
      data-zoom-restore-bar
      className="flex h-full min-w-0 items-center justify-between px-2"
      onDoubleClick={clearMaximize}
    >
      <span className="truncate text-xs font-semibold text-foreground">
        {getPanelTitle(panelId)}
      </span>
      <button
        type="button"
        data-testid="zoom-restore-button"
        onClick={clearMaximize}
        title={t("layout.panelMenu.restore")}
        aria-label={t("layout.panelMenu.restore")}
        className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minimize2 className="h-3.5 w-3.5" />
        {t("layout.panelMenu.restore")}
      </button>
    </div>
  );
}
