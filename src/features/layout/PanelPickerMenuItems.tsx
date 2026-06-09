import { useTranslation } from "react-i18next";
import { Check, FileText, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatShortcut } from "@/lib/platform";
import {
  PANEL_COMMAND_ID,
  useMergedBindings,
} from "@/features/settings/keybindings";
import {
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import type { PanelId } from "./panelIds";
import {
  KEYBOARD_SHORTCUT_MAP,
  PANEL_REGION_MAP,
  TOGGLEABLE_PANELS,
  type PanelRegion,
} from "./panelRegions";
import { PANEL_ICON_MAP } from "./panelIcons";
import type { ToolWindowPanelId } from "./layoutTypes";

interface PanelPickerGroupsProps {
  mode: "toggle" | "pick";
  layoutLocked: boolean;
  isPanelActive: (panel: PanelId) => boolean;
  onTogglePanel: (panel: PanelId) => void;
  onPickPanel?: (panel: ToolWindowPanelId) => void;
  onPanelPointerDown?: (
    panelId: ToolWindowPanelId,
    e: React.PointerEvent<HTMLElement>,
  ) => void;
  onPanelMouseEnter?: (panelId: PanelId) => void;
  showEditor?: boolean;
}

function buildPanelGroups(): {
  region: PanelRegion;
  panels: Exclude<PanelId, "editor">[];
}[] {
  const groups: {
    region: PanelRegion;
    panels: Exclude<PanelId, "editor">[];
  }[] = [];
  for (const panelId of TOGGLEABLE_PANELS) {
    const region = PANEL_REGION_MAP[panelId];
    const last = groups[groups.length - 1];
    if (last && last.region === region) {
      last.panels.push(panelId);
    } else {
      groups.push({ region, panels: [panelId] });
    }
  }
  return groups;
}

const PANEL_GROUPS = buildPanelGroups();

export function PanelPickerMenuItems({
  mode,
  layoutLocked,
  isPanelActive,
  onTogglePanel,
  onPickPanel,
  onPanelPointerDown,
  onPanelMouseEnter,
  showEditor = true,
}: PanelPickerGroupsProps) {
  const { t } = useTranslation();
  const merged = useMergedBindings();
  // Live (possibly rebound) shortcut for a panel; falls back to the static hint.
  const panelShortcut = (panelId: Exclude<PanelId, "editor">) => {
    const cmdId = PANEL_COMMAND_ID[panelId];
    return (
      (cmdId ? merged[cmdId] : undefined) ?? KEYBOARD_SHORTCUT_MAP[panelId]
    );
  };

  const REGION_LABELS: Record<PanelRegion, string> = {
    left: t("layout.regionLeft"),
    right: t("layout.regionRight"),
    "center-bottom": t("layout.regionBottom"),
  };

  if (mode === "pick") {
    return (
      <>
        {PANEL_GROUPS.map((group, gi) => (
          <ContextMenuGroup key={group.region}>
            {gi > 0 && <ContextMenuSeparator />}
            <ContextMenuLabel className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {REGION_LABELS[group.region]}
            </ContextMenuLabel>
            {group.panels.map((panelId) => {
              const PanelIcon = PANEL_ICON_MAP[panelId];
              const shortcut = panelShortcut(panelId);
              return (
                <ContextMenuItem
                  key={panelId}
                  data-testid={`panel-pick-item-${panelId}`}
                  onSelect={() => onPickPanel?.(panelId)}
                >
                  <PanelIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{t(`layout.panel.${panelId}`)}</span>
                  {shortcut && (
                    <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {formatShortcut(shortcut)}
                    </kbd>
                  )}
                </ContextMenuItem>
              );
            })}
          </ContextMenuGroup>
        ))}
      </>
    );
  }

  return (
    <>
      {showEditor && (
        <div>
          <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("layout.regionCenter")}
          </div>
          <div
            role="button"
            tabIndex={0}
            data-panel-toggle-item="editor"
            data-testid="panel-toggle-item-editor"
            data-tauri-drag-region="false"
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onTogglePanel("editor");
              }
            }}
            onClick={() => onTogglePanel("editor")}
            className="flex w-full touch-none select-none items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
          >
            <span className="inline-block h-3.5 w-3.5 shrink-0" />
            <span
              className={cn(
                "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                isPanelActive("editor")
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border",
              )}
            >
              {isPanelActive("editor") && <Check className="h-2.5 w-2.5" />}
            </span>
            <FileText
              aria-hidden
              className="h-4 w-4 shrink-0 text-muted-foreground"
            />
            <span className="flex-1 text-left">{t("layout.panel.editor")}</span>
          </div>
        </div>
      )}

      {PANEL_GROUPS.map((group, gi) => (
        <div key={group.region}>
          {gi > 0 && <div className="my-1 border-t border-border" />}
          <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {REGION_LABELS[group.region]}
          </div>
          {group.panels.map((panelId) => {
            const visible = isPanelActive(panelId);
            const canDrag = !layoutLocked;
            const PanelIcon = PANEL_ICON_MAP[panelId];
            const shortcut = panelShortcut(panelId);
            return (
              <div
                key={panelId}
                role="button"
                tabIndex={0}
                data-panel-toggle-item={panelId}
                data-testid={`panel-toggle-item-${panelId}`}
                data-tauri-drag-region="false"
                onPointerDown={(e) => {
                  if (!canDrag) return;
                  onPanelPointerDown?.(panelId, e);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onTogglePanel(panelId);
                  }
                }}
                onMouseEnter={() => onPanelMouseEnter?.(panelId)}
                className={cn(
                  "flex w-full touch-none select-none items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
                  canDrag && "cursor-grab active:cursor-grabbing",
                )}
              >
                {canDrag ? (
                  <GripVertical
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                  />
                ) : (
                  <span className="inline-block h-3.5 w-3.5 shrink-0" />
                )}
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                    visible
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border",
                  )}
                >
                  {visible && <Check className="h-2.5 w-2.5" />}
                </span>
                <PanelIcon
                  aria-hidden
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
                <span className="flex-1 text-left">
                  {t(`layout.panel.${panelId}`)}
                </span>
                {shortcut && (
                  <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {formatShortcut(shortcut)}
                  </kbd>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
