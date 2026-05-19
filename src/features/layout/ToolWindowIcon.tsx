import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useLayoutStore, type PanelId } from "./layoutStore";
import { PANEL_ICON_MAP } from "./panelIcons";
import { KEYBOARD_SHORTCUT_MAP } from "./panelRegions";

interface ToolWindowIconProps {
  panelId: Exclude<PanelId, "editor">;
  /** Dockview に mount されている (同 group の裏 tab 含む) */
  visible: boolean;
  /** 画面に実際に出ている (active tab or undock overlay) */
  active: boolean;
}

/**
 * Stripe 上のアイコン 1 個。3 状態を視覚化する:
 *
 * | visible | active | UI |
 * |---------|--------|----|
 * | false   | false  | closed: dim text, no background, no bar |
 * | true    | false  | background tab: medium accent, no bar |
 * | true    | true   | shown: strong accent + primary bar |
 * | (false) | true   | undocked overlay: strong accent + ↗ marker |
 *
 * クリックは常に togglePanel に流す:
 * - active なら閉じる
 * - visible だが non-active (裏 tab) → setActive
 * - closed → openPanelAtSlot で復元
 */
export function ToolWindowIcon({
  panelId,
  visible,
  active,
}: ToolWindowIconProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const togglePanel = useLayoutStore((s) => s.togglePanel);

  const label = t(`layout.panel.${panelId}`);
  const shortcut = KEYBOARD_SHORTCUT_MAP[panelId];
  const tooltip = shortcut ? `${label} (${shortcut})` : label;

  // 1 つだけのバリアントを決める
  const variant: "shown" | "background" | "closed" = active
    ? "shown"
    : visible
      ? "background"
      : "closed";

  return (
    <button
      type="button"
      data-stripe-icon={panelId}
      data-state={variant}
      title={tooltip}
      aria-label={label}
      aria-pressed={active}
      onClick={() => togglePanel(panelId)}
      className={cn(
        "relative flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors",
        "active:scale-[0.94] transition-transform duration-75",
        variant === "shown" && "bg-accent text-foreground",
        variant === "background" &&
          "bg-accent/30 text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        variant === "closed" &&
          "text-muted-foreground/60 hover:bg-accent/30 hover:text-foreground",
      )}
    >
      <Icon className="h-4 w-4" />
      {variant === "shown" && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-0 top-1/2 h-3 w-[2px] -translate-y-1/2 rounded-full bg-primary"
        />
      )}
    </button>
  );
}
