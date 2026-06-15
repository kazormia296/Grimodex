import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  Copy,
  Grid2X2,
  MapPin,
  Pencil,
  Spotlight,
  Tag,
  Trash2,
} from "lucide-react";
import type { CodexEntry } from "../api";
import type { CodexType } from "../typeApi";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { useAddToMapBoards } from "@/features/map/hooks/useAddToMapBoards";
import { getCurrentProjectId } from "@/features/project/projectStore";

interface EntryContextMenuProps {
  entry: CodexEntry;
  x: number;
  y: number;
  onClose: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onFindInScenes?: (id: string) => void;
  onChangeType?: (id: string, newType: string) => void;
  onPinToChat?: (id: string) => void;
  codexTypes?: CodexType[];
  customSets?: Array<{ id: string; name: string }>;
  onAddToCustomSet?: (setId: string) => void;
}

export function EntryContextMenu({
  entry,
  x,
  y,
  onClose,
  onDelete,
  onRename,
  onDuplicate,
  onFindInScenes,
  onChangeType,
  onPinToChat,
  codexTypes = [],
  customSets,
  onAddToCustomSet,
}: EntryContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showTypeSubmenu, setShowTypeSubmenu] = useState(false);
  const [showCustomSetSubmenu, setShowCustomSetSubmenu] = useState(false);
  const [showMapSubmenu, setShowMapSubmenu] = useState(false);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const { boards, addToBoard } = useAddToMapBoards(getCurrentProjectId());

  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleDelete = () => {
    onDelete(entry.id);
    onClose();
  };

  const handleRename = () => {
    onRename(entry.id);
    onClose();
  };

  const handleDuplicate = () => {
    onDuplicate?.(entry.id);
    onClose();
  };

  const handleFindInScenes = () => {
    onFindInScenes?.(entry.id);
    onClose();
  };

  const handleChangeType = (newType: string) => {
    onChangeType?.(entry.id, newType);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      data-testid="entry-context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed z-50 min-w-[180px] rounded-lg border border-border bg-popover shadow-lg"
    >
      {/* Header */}
      <div className="border-b border-border px-3 py-2">
        <p className="truncate text-xs font-semibold">{entry.name}</p>
        <p className="text-[10px] text-muted-foreground">{entry.type}</p>
      </div>

      {/* Actions */}
      <div className="py-1">
        <button
          type="button"
          data-testid="entry-context-menu-rename"
          onClick={handleRename}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          {t("codex.contextMenu.rename", "名前を変更")}
        </button>

        <button
          type="button"
          data-testid="entry-context-menu-duplicate"
          onClick={handleDuplicate}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          {t("codex.contextMenu.duplicate", "複製")}
        </button>

        {/* Change type */}
        <div className="relative">
          <button
            type="button"
            data-testid="entry-context-menu-change-type"
            onClick={() => setShowTypeSubmenu((prev) => !prev)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            {t("codex.contextMenu.changeType", "タイプ変更")}
          </button>
          {showTypeSubmenu && codexTypes.length > 0 && (
            <div className="absolute left-full top-0 z-50 min-w-[140px] rounded-lg border border-border bg-popover shadow-lg">
              <div className="py-1">
                {codexTypes.map((ct) => (
                  <button
                    key={ct.slug}
                    type="button"
                    data-testid={`entry-context-menu-type-${ct.slug}`}
                    onClick={() => handleChangeType(ct.slug)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent ${
                      entry.type === ct.slug ? "font-medium" : ""
                    }`}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: typeColorMap[ct.slug]?.fg ?? ct.color,
                      }}
                    />
                    {ct.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="entry-context-menu-find-in-scenes"
          onClick={handleFindInScenes}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
        >
          <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
          {t("codex.contextMenu.findInScenes", "シーンで検索")}
        </button>

        {boards.length > 0 && (
          <div
            className="relative"
            onMouseEnter={() => setShowMapSubmenu(true)}
            onMouseLeave={() => setShowMapSubmenu(false)}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
              <span>{t("codex.contextMenu.addToMap", "Map に追加")}</span>
              <ChevronRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
            </button>
            {showMapSubmenu && (
              <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      void addToBoard(b.id, {
                        nodeRefType: "codex",
                        codexEntryId: entry.id,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {onPinToChat && (
          <button
            type="button"
            data-testid="entry-context-menu-pin-to-chat"
            onClick={() => {
              onPinToChat(entry.id);
              onClose();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
          >
            <Spotlight className="h-3.5 w-3.5 text-muted-foreground" />
            {t("codex.contextMenu.spotlightInChat", "チャットで Spotlight")}
          </button>
        )}

        {onAddToCustomSet && (
          <div className="relative">
            <button
              type="button"
              data-testid="entry-context-menu-add-to-custom-set"
              onClick={() => setShowCustomSetSubmenu((prev) => !prev)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Grid2X2 className="h-3.5 w-3.5 text-muted-foreground" />
              {t(
                "codex.contextMenu.addToCustomSet",
                "Matrix カスタムセットに追加",
              )}
            </button>
            {showCustomSetSubmenu && (
              <div className="absolute left-full top-0 z-50 min-w-[160px] rounded-lg border border-border bg-popover shadow-lg">
                <div className="py-1">
                  {customSets && customSets.length > 0 ? (
                    customSets.map((cs) => (
                      <button
                        key={cs.id}
                        type="button"
                        data-testid={`entry-context-menu-custom-set-${cs.id}`}
                        onClick={() => {
                          onAddToCustomSet(cs.id);
                          onClose();
                        }}
                        className="flex w-full items-center px-3 py-1.5 text-left text-sm hover:bg-accent"
                      >
                        {cs.name}
                      </button>
                    ))
                  ) : (
                    <p className="px-3 py-1.5 text-xs text-muted-foreground">
                      {t("codex.customSets.noSets", "セットなし")}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="my-1 border-t border-border" />

        <button
          type="button"
          data-testid="entry-context-menu-delete"
          onClick={handleDelete}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("codex.contextMenu.delete", "削除")}
        </button>
      </div>
    </div>
  );
}
