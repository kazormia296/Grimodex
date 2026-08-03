import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMapStore } from "./mapStore";
import type { MapMode, ColorByAxis, VisualTheme } from "./types";
import type { AutoArrangeType } from "./layouts/autoArrange";
import type { MapBoard } from "@/db/schema";
import {
  listBoards,
  createBoard,
  renameBoard,
  deleteBoard,
  duplicateBoard,
} from "./mapApi";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ChevronDown,
  MoreVertical,
  Pencil,
  Copy,
  Trash2,
  Map as MapIcon,
  Orbit,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { formatShortcut } from "@/lib/platform";
import { CorrelationDialog } from "./CorrelationDialog";

const ARRANGE_ITEMS: { type: AutoArrangeType; labelKey: string }[] = [
  { type: "reading-order", labelKey: "map.arrange.readingOrder" },
  { type: "force-directed", labelKey: "map.arrange.forceDirected" },
];

const MODES: { key: MapMode; labelKey: string }[] = [
  { key: "free", labelKey: "map.mode.free" },
  { key: "theme", labelKey: "map.mode.theme" },
];

const COLOR_BY_OPTIONS: { value: ColorByAxis; labelKey: string }[] = [
  { value: "none", labelKey: "common.none" },
  { value: "status", labelKey: "map.colorBy.status" },
  { value: "stickyColor", labelKey: "map.colorBy.stickyColor" },
];

const VISUAL_THEME_OPTIONS: { value: VisualTheme; labelKey: string }[] = [
  { value: "default", labelKey: "map.theme.default" },
  { value: "corkboard", labelKey: "map.theme.corkboard" },
  { value: "constellation", labelKey: "map.theme.constellation" },
];

type EditingBoardState =
  | { mode: "rename"; id: string; title: string }
  | { mode: "create" }
  | { mode: "delete"; id: string; title: string }
  | null;

const EXPORT_ITEMS = [
  { type: "svg", labelKey: "map.export.svg" },
  { type: "png", labelKey: "map.export.png" },
  { type: "json", labelKey: "map.export.json" },
] as const;

export function MapHeader() {
  const { t } = useTranslation();
  const mode = useMapStore((s) => s.mode);
  const setMode = useMapStore((s) => s.setMode);
  const show = useMapStore((s) => s.show);
  const setShow = useMapStore((s) => s.setShow);
  const minimapVisible = useMapStore((s) => s.minimapVisible);
  const setMinimapVisible = useMapStore((s) => s.setMinimapVisible);
  const colorBy = useMapStore((s) => s.colorBy);
  const setColorBy = useMapStore((s) => s.setColorBy);
  const visualTheme = useMapStore((s) => s.visualTheme);
  const setVisualTheme = useMapStore((s) => s.setVisualTheme);
  const viewKind = useMapStore((s) => s.viewKind);
  const setViewKind = useMapStore((s) => s.setViewKind);
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);
  const setPendingAutoArrange = useMapStore((s) => s.setPendingAutoArrange);
  const setPendingExport = useMapStore((s) => s.setPendingExport);
  const activeBoardId = useMapStore((s) => s.activeBoardId);
  const setActiveBoardId = useMapStore((s) => s.setActiveBoardId);
  const projectId = useCurrentProjectId();

  const [boards, setBoards] = useState<MapBoard[]>([]);
  const [correlationOpen, setCorrelationOpen] = useState(false);
  const activeBoard = boards.find((b) => b.id === activeBoardId);

  const [editingBoard, setEditingBoard] = useState<EditingBoardState>(null);
  // Set synchronously inside DropdownMenuItem.onSelect just before opening
  // the popover. Read inside DropdownMenuContent.onCloseAutoFocus to suppress
  // the trigger refocus that would otherwise close the popover via
  // focus-outside. Captured via ref because the close-auto-focus callback's
  // closure may pre-date the editingBoard state update.
  const suppressTriggerRefocusRef = useRef(false);

  const reloadBoards = useCallback(async () => {
    const all = await listBoards(projectId);
    setBoards(all);
    return all;
  }, [projectId]);

  useEffect(() => {
    reloadBoards().catch(console.error);
  }, [reloadBoards, activeBoardId]);

  async function commitBoardEdit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || !editingBoard) return;
    if (editingBoard.mode === "rename") {
      await renameBoard(editingBoard.id, trimmed);
      await reloadBoards();
    } else {
      const newBoard = await createBoard(projectId, trimmed);
      const all = await reloadBoards();
      if (all.length === 1 || !activeBoardId) {
        setActiveBoardId(newBoard.id);
      }
    }
    setEditingBoard(null);
  }

  async function handleBoardDuplicate(id: string) {
    const newBoard = await duplicateBoard(id, projectId);
    await reloadBoards();
    setActiveBoardId(newBoard.id);
  }

  async function commitBoardDelete(id: string) {
    await deleteBoard(id);
    const remaining = await reloadBoards();
    if (activeBoardId === id) {
      setActiveBoardId(remaining[0]?.id ?? null);
    }
    setEditingBoard(null);
  }

  return (
    <div
      data-panel-header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 12px",
        borderBottom: "1px solid var(--border)",
        color: "var(--foreground)",
        flexShrink: 0,
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      <MapIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span style={{ fontWeight: 500, marginRight: 4 }}>
        {t("layout.panel.map")}
      </span>

      {/* View toggle: board | galaxy */}
      <div style={{ display: "flex", gap: 2 }}>
        <Button
          variant={viewKind === "board" ? "default" : "outline"}
          size="xs"
          onClick={() => setViewKind("board")}
          title={t("map.view.switchToBoard")}
          className={viewKind === "board" ? "font-semibold" : "font-normal"}
        >
          {t("map.view.board")}
        </Button>
        <Button
          variant={viewKind === "galaxy" ? "default" : "outline"}
          size="xs"
          onClick={() => setViewKind("galaxy")}
          title={t("map.view.switchToGalaxy")}
          className={viewKind === "galaxy" ? "font-semibold" : "font-normal"}
        >
          <Orbit className="mr-1 h-3 w-3" aria-hidden />
          {t("map.view.galaxy")}
        </Button>
      </div>

      {viewKind === "board" && (
        <>
          <Divider />

          {/* Board selector */}
          <Popover
            open={editingBoard !== null}
            onOpenChange={(open) => {
              if (!open) setEditingBoard(null);
            }}
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PopoverAnchor asChild>
                  <Button
                    variant="outline"
                    size="xs"
                    title={t("map.tooltip.switchBoard")}
                    className="max-w-[140px] overflow-hidden"
                  >
                    <span className="truncate">
                      {activeBoard?.title ?? "—"}
                    </span>
                    <ChevronDown className="ml-1 h-3 w-3" aria-hidden />
                  </Button>
                </PopoverAnchor>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="min-w-[180px]"
                onCloseAutoFocus={(e) => {
                  if (suppressTriggerRefocusRef.current) {
                    suppressTriggerRefocusRef.current = false;
                    e.preventDefault();
                  }
                }}
              >
                {boards.map((b) => {
                  const isActive = b.id === activeBoardId;
                  const canDelete = boards.length > 1;
                  return (
                    <DropdownMenuItem
                      key={b.id}
                      onSelect={() => setActiveBoardId(b.id)}
                      onKeyDown={(e) => {
                        // Per-row keyboard shortcuts mirror the hover icons.
                        // Keep them after Radix's own keys (Arrow / Enter / Esc)
                        // resolve naturally — only handle our additions.
                        if (e.key === "F2") {
                          e.preventDefault();
                          e.stopPropagation();
                          suppressTriggerRefocusRef.current = true;
                          setEditingBoard({
                            mode: "rename",
                            id: b.id,
                            title: b.title,
                          });
                        } else if ((e.ctrlKey || e.metaKey) && e.key === "d") {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleBoardDuplicate(b.id);
                        } else if (
                          (e.key === "Delete" || e.key === "Backspace") &&
                          canDelete
                        ) {
                          e.preventDefault();
                          e.stopPropagation();
                          suppressTriggerRefocusRef.current = true;
                          setEditingBoard({
                            mode: "delete",
                            id: b.id,
                            title: b.title,
                          });
                        }
                      }}
                      className={`group flex items-center justify-between gap-1 ${isActive ? "bg-accent" : ""}`}
                    >
                      <span className="truncate">{b.title}</span>
                      {/* Per-row hover actions. Each button preventDefault on
                      onSelect via pointer-down so Radix does not close the
                      menu or fire the row's onSelect (which would switch
                      the active board) — only the icon's own intent runs. */}
                      <div
                        className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          title={t("map.tooltip.renameBoardShortcut")}
                          aria-label={t("map.tooltip.renameBoardAria", {
                            title: b.title,
                          })}
                          className="h-5 w-5 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            suppressTriggerRefocusRef.current = true;
                            setEditingBoard({
                              mode: "rename",
                              id: b.id,
                              title: b.title,
                            });
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          title={t("map.tooltip.duplicateBoardShortcut", {
                            shortcut: formatShortcut("Ctrl+D"),
                          })}
                          aria-label={t("map.tooltip.duplicateBoardAria", {
                            title: b.title,
                          })}
                          className="h-5 w-5 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleBoardDuplicate(b.id);
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        {canDelete && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            title={t("map.tooltip.deleteBoardShortcut")}
                            aria-label={t("map.tooltip.deleteBoardAria", {
                              title: b.title,
                            })}
                            className="h-5 w-5 text-muted-foreground hover:bg-destructive/15 hover:text-[color:var(--destructive)]"
                            onClick={(e) => {
                              e.stopPropagation();
                              suppressTriggerRefocusRef.current = true;
                              setEditingBoard({
                                mode: "delete",
                                id: b.id,
                                title: b.title,
                              });
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    suppressTriggerRefocusRef.current = true;
                    setEditingBoard({ mode: "create" });
                  }}
                >
                  {t("map.board.newBoardMenuItem")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <PopoverContent
              align="start"
              className="w-64"
              onFocusOutside={(e) => {
                // Stray focus shifts (e.g. trigger refocus from the dropdown
                // closing) should not auto-close. Outside-click and Escape
                // still dismiss the popover.
                e.preventDefault();
              }}
            >
              {editingBoard?.mode === "delete" ? (
                <BoardDeleteConfirm
                  key={editingBoard.id}
                  title={editingBoard.title}
                  onConfirm={() => void commitBoardDelete(editingBoard.id)}
                  onCancel={() => setEditingBoard(null)}
                />
              ) : editingBoard !== null ? (
                <BoardEditForm
                  key={
                    editingBoard.mode === "rename"
                      ? editingBoard.id
                      : "__create__"
                  }
                  mode={editingBoard.mode}
                  initialValue={
                    editingBoard.mode === "rename" ? editingBoard.title : ""
                  }
                  onSubmit={(value) => void commitBoardEdit(value)}
                  onCancel={() => setEditingBoard(null)}
                />
              ) : null}
            </PopoverContent>
          </Popover>

          {/* Mode buttons */}
          <div style={{ display: "flex", gap: 2 }}>
            {MODES.map(({ key, labelKey }) => {
              const active = mode === key;
              const label = t(labelKey);
              return (
                <Button
                  key={key}
                  variant={active ? "default" : "outline"}
                  size="xs"
                  onClick={() => setMode(key)}
                  title={t("map.tooltip.modeButton", { mode: label })}
                  style={
                    active
                      ? {
                          background: "#534AB7",
                          borderColor: "#534AB7",
                          color: "#fff",
                        }
                      : undefined
                  }
                  className={active ? "font-semibold" : "font-normal"}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          <Divider />

          {/* Show checkboxes */}
          <ShowCheckbox
            label={t("map.palette.showScenes")}
            checked={show.scenes}
            onChange={(v) => setShow({ scenes: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showCodex")}
            checked={show.codex}
            onChange={(v) => setShow({ codex: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showStickies")}
            checked={show.stickies}
            onChange={(v) => setShow({ stickies: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showSnippets")}
            checked={show.snippets}
            onChange={(v) => setShow({ snippets: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showNotes")}
            checked={show.notes}
            onChange={(v) => setShow({ notes: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showAiBranch")}
            checked={show.aiBranch}
            onChange={(v) => setShow({ aiBranch: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showEdges")}
            checked={show.derivedEdges}
            onChange={(v) => setShow({ derivedEdges: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showUserEdges")}
            checked={show.userEdges}
            onChange={(v) => setShow({ userEdges: v })}
          />
          <ShowCheckbox
            label={t("map.palette.showFrames")}
            checked={show.frames}
            onChange={(v) => setShow({ frames: v })}
          />

          {/* ⋮ overflow menu */}
          <div style={{ marginLeft: "auto" }}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  title={t("map.menu.menu")}
                  aria-label={t("map.menu.menu")}
                >
                  <MoreVertical className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                <DropdownMenuItem onSelect={() => setSearchVisible(true)}>
                  {t("map.menu.searchNodes")}
                  <DropdownMenuShortcut>
                    {formatShortcut("Ctrl+F")}
                  </DropdownMenuShortcut>
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>
                  {t("map.menu.displaySettings")}
                </DropdownMenuLabel>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("map.menu.color")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={colorBy}
                      onValueChange={(v) => setColorBy(v as ColorByAxis)}
                    >
                      {COLOR_BY_OPTIONS.map(({ value, labelKey }) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {t(labelKey)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    {t("map.menu.theme")}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={visualTheme}
                      onValueChange={(v) => setVisualTheme(v as VisualTheme)}
                    >
                      {VISUAL_THEME_OPTIONS.map(({ value, labelKey }) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {t(labelKey)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuCheckboxItem
                  checked={minimapVisible}
                  onCheckedChange={(v) => setMinimapVisible(v === true)}
                >
                  {t("map.menu.minimap")}
                </DropdownMenuCheckboxItem>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>
                  {t("map.menu.autoArrange")}
                </DropdownMenuLabel>
                {ARRANGE_ITEMS.map((item) => (
                  <DropdownMenuItem
                    key={item.type}
                    onSelect={() => setPendingAutoArrange(item.type)}
                  >
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />

                <DropdownMenuLabel>{t("map.menu.generate")}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => setCorrelationOpen(true)}>
                  {t("map.menu.generateCorrelation")}
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuLabel>{t("map.menu.export")}</DropdownMenuLabel>
                {EXPORT_ITEMS.map((item) => (
                  <DropdownMenuItem
                    key={item.type}
                    onSelect={() => setPendingExport(item.type)}
                  >
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )}

      {correlationOpen && (
        <CorrelationDialog
          projectId={projectId}
          onGenerated={async (boardId) => {
            await reloadBoards();
            setActiveBoardId(boardId);
            setCorrelationOpen(false);
          }}
          onClose={() => setCorrelationOpen(false)}
        />
      )}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: 1,
        height: 16,
        background: "var(--border)",
        margin: "0 2px",
        flexShrink: 0,
      }}
    />
  );
}

function BoardEditForm({
  mode,
  initialValue,
  onSubmit,
  onCancel,
}: {
  mode: "rename" | "create";
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSubmit(trimmed);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <label
        style={{
          fontSize: 11,
          color: "var(--muted-foreground)",
          fontWeight: 500,
        }}
      >
        {mode === "rename"
          ? t("map.board.renameLabel")
          : t("map.board.createLabel")}
      </label>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={
          mode === "create" ? t("map.board.newBoardPlaceholder") : ""
        }
        style={{
          fontSize: 12,
          padding: "5px 8px",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--background)",
          color: "var(--foreground)",
          outline: "none",
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="default"
          size="xs"
          disabled={!trimmed}
          style={{
            background: "#534AB7",
            borderColor: "#534AB7",
            color: "#fff",
          }}
        >
          {mode === "rename" ? t("map.board.renameAction") : t("common.create")}
        </Button>
      </div>
    </form>
  );
}

function BoardDeleteConfirm({
  title,
  onConfirm,
  onCancel,
}: {
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>
        {t("map.board.deleteTitle")}
      </div>
      <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
        {t("map.board.deleteConfirm", { title })}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 4,
        }}
      >
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="default"
          size="xs"
          onClick={onConfirm}
          style={{
            background: "var(--destructive)",
            borderColor: "var(--destructive)",
            color: "var(--destructive-foreground)",
          }}
        >
          {t("common.delete")}
        </Button>
      </div>
    </div>
  );
}

function ShowCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
        fontSize: 11,
        userSelect: "none",
      }}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="h-3.5 w-3.5"
      />
      {label}
    </label>
  );
}
