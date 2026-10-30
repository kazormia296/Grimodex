import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  OVERLAY_CONTENT_TOP_CSS,
  OVERLAY_RAIL_SIZE,
  getOverlayLayerId,
} from "./layoutConstants";
import { findOverlayOfPanel, getOverlays } from "./layoutStateUtils";
import { useLayoutStore } from "./layoutStore";
import type { OverlayId } from "./layoutTypes";
import { PANEL_ICON_MAP } from "./panelIcons";
import { usePanelBusy } from "./usePanelBusy";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

interface OverlayRailProps {
  side: OverlayId;
}

/**
 * 画面の一番端にある、オーバーレイの操作の列（rail）。
 * パネルが置かれている間だけ幅 OVERLAY_RAIL_SIZE を取り、つまみにパネルの
 * アイコンと縦書きの名前を出す。開閉に関わらず幅は変わらない。
 *
 * 縦書き（writing-mode）の要素の中では flex の main/cross 軸が入れ替わるため、
 * 縦書きは末端の span だけにして、レイアウトは外側の横書きの button で行う。
 * Stripe のアイコン（平らなグレーの面）とは、琥珀色の縁と文字で区別する。
 * 右クリックで「元に戻す（領域へ）」を出す（ロック中は無効）。処理中は busy の印を出す。
 */
export const OverlayRail = memo(function OverlayRail({
  side,
}: OverlayRailProps) {
  const { t } = useTranslation();
  const panel = useLayoutStore((s) => getOverlays(s.layout)[side].panel);
  const open = useLayoutStore((s) => s.openOverlay === side);
  const toggleOverlay = useLayoutStore((s) => s.toggleOverlay);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const restorePanelFromOverlay = useLayoutStore(
    (s) => s.restorePanelFromOverlay,
  );
  const showPanel = useLayoutStore((s) => s.showPanel);
  // panel が空のときは描かないが、hook の順序は固定するため先に呼ぶ。
  const busy = usePanelBusy(panel ?? "editor");

  if (panel === null) return null;

  const Icon = PANEL_ICON_MAP[panel];
  const label = t(`layout.panel.${panel}`);

  return (
    <div
      data-overlay-rail={side}
      className="relative shrink-0"
      style={{
        width: OVERLAY_RAIL_SIZE,
        // grid の背景（canvas）と同じ色で、rail が境目に見えないようにする。
        background: "var(--gx-canvas-bg)",
        paddingTop: OVERLAY_CONTENT_TOP_CSS,
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            data-overlay-knob={side}
            data-state={open ? "open" : "closed"}
            aria-expanded={open}
            aria-controls={getOverlayLayerId(side)}
            aria-label={t("layout.overlay.toggle", { panel: label })}
            title={label}
            onClick={() => toggleOverlay(side)}
            className={cn(
              "relative flex w-full select-none flex-col items-center gap-1.5 rounded-md border py-2 text-xs font-medium transition-colors",
              "border-[color:color-mix(in_oklch,var(--overlay-accent)_55%,transparent)]",
              "text-[color:var(--overlay-accent)]",
              open
                ? "bg-[color:color-mix(in_oklch,var(--overlay-accent)_22%,transparent)]"
                : "bg-[color:color-mix(in_oklch,var(--overlay-accent)_9%,transparent)] hover:bg-[color:color-mix(in_oklch,var(--overlay-accent)_16%,transparent)]",
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span
              aria-hidden
              className="whitespace-nowrap"
              style={{ writingMode: "vertical-rl" }}
            >
              {label}
            </span>
            {busy && (
              <span
                aria-hidden
                data-testid="overlay-busy-badge"
                className="pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
              />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* 「サイドバーから削除」は出さない（overlay のパネルは領域へ戻すだけ）。 */}
          <ContextMenuItem
            data-testid={`ctx-overlay-restore-${side}`}
            disabled={layoutLocked}
            onSelect={() => {
              restorePanelFromOverlay(panel);
              // 戻した先で開いて見せる（store は active にしない）。
              if (
                findOverlayOfPanel(useLayoutStore.getState().layout, panel) ===
                null
              ) {
                showPanel(panel);
              }
            }}
          >
            {t("layout.overlay.restore")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
});
