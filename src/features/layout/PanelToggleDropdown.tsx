import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGrid, ChevronDown, Check, Lock, Unlock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore, type PanelId } from "./layoutStore";
import {
  TOGGLEABLE_PANELS,
  KEYBOARD_SHORTCUT_MAP,
  PANEL_REGION_MAP,
  type PanelRegion,
} from "./panelRegions";
import { PanelHighlightOverlay } from "./PanelHighlightOverlay";

/** Force re-render when dockview adds/removes panels */
function useDockviewVersion() {
  const api = useLayoutStore((s) => s.dockviewApi);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!api) return;
    const bump = () => setVersion((v) => v + 1);
    const d1 = api.onDidAddPanel(bump);
    const d2 = api.onDidRemovePanel(bump);
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [api]);

  return version;
}

export function PanelToggleDropdown() {
  const { t } = useTranslation();
  const { dockviewApi, togglePanel, layoutLocked, toggleLayoutLock } =
    useLayoutStore();
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredPanelId, setHoveredPanelId] = useState<PanelId | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDockviewVersion();

  const REGION_LABELS: Record<PanelRegion, string> = {
    left: t("layout.regionLeft"),
    right: t("layout.regionRight"),
    "center-bottom": t("layout.regionBottom"),
  };

  // Click-outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setHoveredPanelId(null);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Escape to close
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

  function isPanelVisible(panelId: PanelId) {
    return dockviewApi?.getPanel(panelId) !== undefined;
  }

  // Group panels by region for separators
  const groups: { region: PanelRegion; panels: PanelId[] }[] = [];
  for (const panelId of TOGGLEABLE_PANELS) {
    const region = PANEL_REGION_MAP[panelId];
    const last = groups[groups.length - 1];
    if (last && last.region === region) {
      last.panels.push(panelId);
    } else {
      groups.push({ region, panels: [panelId] });
    }
  }

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        title={t("layout.panelToggle")}
        onClick={() => {
          setIsOpen((o) => !o);
          if (isOpen) setHoveredPanelId(null);
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded px-2 text-sm transition-colors",
          isOpen
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <LayoutGrid className="h-4 w-4" />
        <span>{t("layout.panels")}</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", isOpen && "rotate-180")}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="absolute right-0 top-full z-50 mt-1 min-w-64 rounded-md border border-border bg-background py-1 shadow-lg"
          onMouseLeave={() => setHoveredPanelId(null)}
        >
          {groups.map((group, gi) => (
            <div key={group.region}>
              {gi > 0 && <div className="my-1 border-t border-border" />}
              <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {REGION_LABELS[group.region]}
              </div>
              {group.panels.map((panelId) => {
                const visible = isPanelVisible(panelId);
                return (
                  <button
                    key={panelId}
                    type="button"
                    onClick={() => togglePanel(panelId)}
                    onMouseEnter={() => setHoveredPanelId(panelId)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                  >
                    {/* Checkbox */}
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

                    {/* Panel name */}
                    <span className="flex-1 text-left">
                      {t(`layout.panel.${panelId}`)}
                    </span>

                    {/* Keyboard shortcut */}
                    {KEYBOARD_SHORTCUT_MAP[panelId] && (
                      <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {KEYBOARD_SHORTCUT_MAP[panelId]}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}

          {/* Layout lock toggle */}
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
      )}

      {/* Hover highlight overlay */}
      <PanelHighlightOverlay panelId={isOpen ? hoveredPanelId : null} />
    </div>
  );
}
