import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutGrid,
  ChevronDown,
  Check,
  Lock,
  Unlock,
  GripVertical,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";
import type { PanelId } from "./panelIds";
import {
  TOGGLEABLE_PANELS,
  KEYBOARD_SHORTCUT_MAP,
  PANEL_REGION_MAP,
  type PanelRegion,
} from "./panelRegions";
import { PANEL_ICON_MAP } from "./panelIcons";
import { PanelHighlightOverlay } from "./PanelHighlightOverlay";
import { usePanelDropdownPointerDrag } from "./usePanelDropdownPointerDrag";
import type { ToolWindowPanelId } from "./layoutTypes";

export function PanelToggleDropdown() {
  const { t } = useTranslation();
  const { togglePanel, layoutLocked, toggleLayoutLock, isPanelActive } =
    useLayoutStore();
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredPanelId, setHoveredPanelId] = useState<PanelId | null>(null);
  const [menuStyle, setMenuStyle] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const { handleRowPointerDown } = usePanelDropdownPointerDrag({
    layoutLocked,
    togglePanel,
    onDragSessionStart: () => {
      setIsOpen(false);
      setHoveredPanelId(null);
    },
  });

  useEffect(() => {
    const open = () => setIsOpen(true);
    const close = () => {
      setIsOpen(false);
      setHoveredPanelId(null);
    };
    window.addEventListener("tour-open-panel-dropdown", open);
    window.addEventListener("tour-close-panel-dropdown", close);
    return () => {
      window.removeEventListener("tour-open-panel-dropdown", open);
      window.removeEventListener("tour-close-panel-dropdown", close);
    };
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || !toggleRef.current) {
      setMenuStyle(null);
      return;
    }

    function updatePosition() {
      const rect = toggleRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuStyle({
        top: rect.bottom + 4,
        left: rect.right,
        minWidth: Math.max(rect.width, 256),
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (toggleRef.current?.contains(e.target as Node)) return;
      setIsOpen(false);
      setHoveredPanelId(null);
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
        setHoveredPanelId(null);
      }
    }
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  const REGION_LABELS: Record<PanelRegion, string> = {
    left: t("layout.regionLeft"),
    right: t("layout.regionRight"),
    "center-bottom": t("layout.regionBottom"),
  };

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

  const menu =
    isOpen && menuStyle ? (
      <div
        ref={menuRef}
        data-tour="panel-toggle-menu"
        data-tauri-drag-region="false"
        className="fixed z-[100] min-w-64 rounded-md border border-border bg-popover py-1 shadow-lg"
        style={{
          top: menuStyle.top,
          left: menuStyle.left,
          minWidth: menuStyle.minWidth,
          transform: "translateX(-100%)",
        }}
        onMouseLeave={() => setHoveredPanelId(null)}
      >
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
                togglePanel("editor");
              }
            }}
            onClick={() => togglePanel("editor")}
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

        {groups.map((group, gi) => (
          <div key={group.region}>
            {gi > 0 && <div className="my-1 border-t border-border" />}
            <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {REGION_LABELS[group.region]}
            </div>
            {group.panels.map((panelId) => {
              const visible = isPanelActive(panelId);
              const canDrag = !layoutLocked;
              const PanelIcon = PANEL_ICON_MAP[panelId];
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
                    handleRowPointerDown(panelId as ToolWindowPanelId, e);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      togglePanel(panelId);
                    }
                  }}
                  onMouseEnter={() => setHoveredPanelId(panelId)}
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
                  {KEYBOARD_SHORTCUT_MAP[panelId] && (
                    <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {KEYBOARD_SHORTCUT_MAP[panelId]}
                    </kbd>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div className="my-1 border-t border-border" />
        <button
          type="button"
          onClick={toggleLayoutLock}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
        >
          {layoutLocked ? (
            <Lock className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Unlock className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="flex-1 text-left">
            {layoutLocked ? t("layout.lockedLayout") : t("layout.lockLayout")}
          </span>
        </button>
      </div>
    ) : null;

  return (
    <>
      <div
        className="relative"
        data-tour="panel-toggle-root"
        data-tour-target="panel-toggle-btn"
        data-tauri-drag-region="false"
        data-testid="panel-toggle-root"
      >
        <button
          ref={toggleRef}
          type="button"
          title={t("layout.panelToggle")}
          onClick={() => {
            setIsOpen((o) => !o);
            if (isOpen) setHoveredPanelId(null);
          }}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded px-2 text-sm transition-colors active:scale-[0.97] transition-transform duration-75",
            isOpen
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <LayoutGrid className="h-4 w-4" />
          <span>{t("layout.panels")}</span>
          <ChevronDown
            className={cn(
              "h-3 w-3 transition-transform",
              isOpen && "rotate-180",
            )}
          />
        </button>

        <PanelHighlightOverlay panelId={isOpen ? hoveredPanelId : null} />
      </div>

      {menu && createPortal(menu, document.body)}
    </>
  );
}
