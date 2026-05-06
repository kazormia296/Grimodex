import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useTreeStore } from "@/features/tree/treeStore";
import type { SceneStatus } from "@/features/tree/treeStore";
import { StatusDot } from "@/features/tree/StatusDot";

interface Command {
  id: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
  available: boolean;
  run: () => void | Promise<void>;
}

interface CommandPaletteProps {
  onClose: () => void;
}

const STATUS_OPTIONS: SceneStatus[] = [
  "outline",
  "draft",
  "complete",
  "revision",
  "final",
];

const STATUS_LABELS: Record<SceneStatus, string> = {
  outline: "Outline",
  draft: "Draft",
  complete: "Complete",
  revision: "Revision",
  final: "Final",
};

function buildCommands(
  activeSceneId: string,
  t: (k: string) => string,
): Command[] {
  const hasScene = !!activeSceneId;
  return STATUS_OPTIONS.map<Command>((status) => ({
    id: `set-scene-status-${status}`,
    label: `${t("commandPalette.setSceneStatus")}: ${STATUS_LABELS[status]}`,
    description: hasScene
      ? t("commandPalette.setSceneStatusDescription")
      : t("commandPalette.noActiveScene"),
    icon: <StatusDot status={status} />,
    available: hasScene,
    run: async () => {
      if (!activeSceneId) return;
      await useTreeStore.getState().setStatus(activeSceneId, status);
      toast.success(
        `${t("commandPalette.setSceneStatus")}: ${STATUS_LABELS[status]}`,
      );
    },
  }));
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const allCommands = useMemo(
    () => buildCommands(activeSceneId, t),
    [activeSceneId, t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allCommands;
    return allCommands.filter((c) => c.label.toLowerCase().includes(q));
  }, [allCommands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const runCommand = useCallback(
    async (cmd: Command) => {
      if (!cmd.available) return;
      await cmd.run();
      onClose();
    },
    [onClose],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && filtered[selectedIndex]) {
        e.preventDefault();
        void runCommand(filtered[selectedIndex]);
      }
    },
    [filtered, selectedIndex, runCommand],
  );

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 560,
          maxWidth: "90vw",
          background: "var(--popover)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontSize: 16, color: "var(--muted-foreground)" }}>
            ⌘
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("commandPalette.placeholder")}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 14,
              color: "var(--foreground)",
            }}
          />
        </div>
        <div style={{ maxHeight: 360, overflowY: "auto" }}>
          {filtered.length === 0 && (
            <div
              style={{
                padding: "20px",
                textAlign: "center",
                fontSize: 13,
                color: "var(--muted-foreground)",
              }}
            >
              {t("commandPalette.noMatch")}
            </div>
          )}
          {filtered.map((cmd, i) => {
            const isSelected = i === selectedIndex;
            return (
              <button
                key={cmd.id}
                type="button"
                disabled={!cmd.available}
                onClick={() => void runCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(i)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  padding: "8px 14px",
                  border: "none",
                  background: isSelected ? "var(--accent)" : "transparent",
                  color: cmd.available
                    ? "var(--foreground)"
                    : "var(--muted-foreground)",
                  cursor: cmd.available ? "pointer" : "not-allowed",
                  textAlign: "left",
                  fontSize: 13,
                }}
              >
                {cmd.icon && <span style={{ flexShrink: 0 }}>{cmd.icon}</span>}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{cmd.label}</div>
                  {cmd.description && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--muted-foreground)",
                        marginTop: 2,
                      }}
                    >
                      {cmd.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
