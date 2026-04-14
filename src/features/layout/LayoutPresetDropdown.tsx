import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Columns3,
  ChevronDown,
  Save,
  Trash2,
  Check,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";
import { getBuiltinPresets } from "./layoutPresets";

export function LayoutPresetDropdown() {
  const { t } = useTranslation();
  const {
    customPresets,
    activePresetId,
    applyPreset,
    saveCurrentAsPreset,
    deletePreset,
    resetToDefaultLayout,
  } = useLayoutStore();

  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Click-outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setIsSaving(false);
        setSaveName("");
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
        if (isSaving) {
          setIsSaving(false);
          setSaveName("");
        } else {
          setIsOpen(false);
        }
      }
    }
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, isSaving]);

  // Focus input when save mode opens
  useEffect(() => {
    if (isSaving) {
      inputRef.current?.focus();
    }
  }, [isSaving]);

  const builtinPresets = getBuiltinPresets();

  const activeName =
    builtinPresets.find((p) => p.id === activePresetId)?.name ??
    customPresets.find((p) => p.id === activePresetId)?.name ??
    null;

  function handleSave() {
    const trimmed = saveName.trim();
    if (!trimmed) return;
    saveCurrentAsPreset(trimmed);
    setIsSaving(false);
    setSaveName("");
  }

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        title={t("layout.preset.title")}
        onClick={() => {
          setIsOpen((o) => !o);
          if (isOpen) {
            setIsSaving(false);
            setSaveName("");
          }
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded px-2 text-sm transition-colors",
          isOpen
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <Columns3 className="h-4 w-4" />
        <span>{activeName ?? t("layout.preset.layout")}</span>
        <ChevronDown
          className={cn("h-3 w-3 transition-transform", isOpen && "rotate-180")}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-56 rounded-md border border-border bg-background py-1 shadow-lg">
          {/* Builtin presets */}
          <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t("layout.preset.builtinSection")}
          </div>
          {builtinPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                applyPreset(preset.id);
                setIsOpen(false);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <span
                className={cn(
                  "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                  activePresetId === preset.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {activePresetId === preset.id && (
                  <Check className="h-2.5 w-2.5" />
                )}
              </span>
              <span className="flex-1 text-left">{preset.name}</span>
            </button>
          ))}

          {/* Custom presets */}
          {customPresets.length > 0 && (
            <>
              <div className="my-1 border-t border-border" />
              <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("layout.preset.customSection")}
              </div>
              {customPresets.map((preset) => (
                <div
                  key={preset.id}
                  className="group flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <button
                    type="button"
                    onClick={() => {
                      applyPreset(preset.id);
                      setIsOpen(false);
                    }}
                    className="flex flex-1 items-center gap-2"
                  >
                    <span
                      className={cn(
                        "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                        activePresetId === preset.id
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {activePresetId === preset.id && (
                        <Check className="h-2.5 w-2.5" />
                      )}
                    </span>
                    <span className="flex-1 text-left">{preset.name}</span>
                  </button>
                  <button
                    type="button"
                    title={t("common.delete")}
                    onClick={(e) => {
                      e.stopPropagation();
                      deletePreset(preset.id);
                    }}
                    className="hidden rounded p-0.5 text-muted-foreground hover:text-destructive group-hover:block"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </>
          )}

          {/* Save current layout */}
          <div className="my-1 border-t border-border" />
          {isSaving ? (
            <div className="flex items-center gap-1 px-3 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSave();
                  e.stopPropagation();
                }}
                placeholder={t("layout.preset.saveName")}
                className="flex-1 rounded border border-border bg-muted px-2 py-1 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!saveName.trim()}
                className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
              >
                <Check className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsSaving(true)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            >
              <Save className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{t("layout.preset.saveLayout")}</span>
            </button>
          )}

          {/* Reset to default */}
          <div className="my-1 border-t border-border" />
          <button
            type="button"
            onClick={() => {
              resetToDefaultLayout();
              setIsOpen(false);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>{t("layout.preset.resetDefault")}</span>
          </button>
        </div>
      )}
    </div>
  );
}
