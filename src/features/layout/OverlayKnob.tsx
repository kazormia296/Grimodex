import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { HORIZONTAL_STRIPE_SIZE, getOverlayLayerId } from "./layoutConstants";
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

interface OverlayKnobProps {
  side: OverlayId;
}

/**
 * オーバーレイのつまみ。上段の角（side stripe 列 × center stripe 行）に、置かれた
 * パネルのアイコンを丸く 1 つだけ出す。center stripe はこの角を譲って内側から始まる
 * （layoutMetrics の lknob／rknob）。パネル名は title と aria-label で出す。
 *
 * Stripe のアイコン（平らなグレーの面）とは、琥珀色の縁と面で区別する。
 * 右クリックで「元に戻す（領域へ）」を出す（ロック中は無効）。処理中は busy の印を出す。
 */
export const OverlayKnob = memo(function OverlayKnob({
  side,
}: OverlayKnobProps) {
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
      data-overlay-knob-cell={side}
      className="flex h-full w-full min-w-0 items-center justify-center"
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
              "relative flex shrink-0 select-none items-center justify-center rounded-full border transition-colors",
              "border-[color:color-mix(in_oklch,var(--overlay-accent)_55%,transparent)]",
              "text-[color:var(--overlay-accent)]",
              open
                ? "bg-[color:color-mix(in_oklch,var(--overlay-accent)_22%,transparent)]"
                : "bg-[color:color-mix(in_oklch,var(--overlay-accent)_9%,transparent)] hover:bg-[color:color-mix(in_oklch,var(--overlay-accent)_16%,transparent)]",
            )}
            style={{
              width: HORIZONTAL_STRIPE_SIZE,
              height: HORIZONTAL_STRIPE_SIZE,
            }}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
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
