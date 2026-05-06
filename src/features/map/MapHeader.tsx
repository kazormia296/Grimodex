import { useState, useRef, useEffect, useCallback } from "react";
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

const PROJECT_ID = "default-project";

const ARRANGE_ITEMS: { type: AutoArrangeType; label: string }[] = [
  { type: "reading-order", label: "Grid: 読み順" },
  { type: "force-directed", label: "Force-directed" },
];

const MODES: { key: MapMode; label: string }[] = [
  { key: "free", label: "Free" },
  { key: "theme", label: "Theme" },
];

const COLOR_BY_OPTIONS: { value: ColorByAxis; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "status", label: "ステータス" },
  { value: "stickyColor", label: "付箋カラー" },
];

const VISUAL_THEME_OPTIONS: { value: VisualTheme; label: string }[] = [
  { value: "default", label: "デフォルト" },
  { value: "corkboard", label: "コルクボード" },
  { value: "constellation", label: "星座" },
];

export function MapHeader() {
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
  const setSearchVisible = useMapStore((s) => s.setSearchVisible);
  const setPendingAutoArrange = useMapStore((s) => s.setPendingAutoArrange);
  const setPendingExport = useMapStore((s) => s.setPendingExport);
  const activeBoardId = useMapStore((s) => s.activeBoardId);
  const setActiveBoardId = useMapStore((s) => s.setActiveBoardId);

  const [boards, setBoards] = useState<MapBoard[]>([]);
  const activeBoard = boards.find((b) => b.id === activeBoardId);

  const [menuOpen, setMenuOpen] = useState(false);
  const [boardMenuOpen, setBoardMenuOpen] = useState(false);
  const [boardSubMenu, setBoardSubMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const boardMenuRef = useRef<HTMLDivElement>(null);

  const reloadBoards = useCallback(async () => {
    const all = await listBoards(PROJECT_ID);
    setBoards(all);
    return all;
  }, []);

  useEffect(() => {
    reloadBoards().catch(console.error);
  }, [reloadBoards, activeBoardId]);

  useEffect(() => {
    if (!menuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!boardMenuOpen) return;
    function onMouseDown(e: MouseEvent) {
      if (
        boardMenuRef.current &&
        !boardMenuRef.current.contains(e.target as Node)
      ) {
        setBoardMenuOpen(false);
        setBoardSubMenu(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [boardMenuOpen]);

  async function handleBoardCreate() {
    const title = window.prompt("ボード名を入力", "新規ボード");
    if (!title?.trim()) return;
    const newBoard = await createBoard(PROJECT_ID, title.trim());
    const all = await reloadBoards();
    if (all.length === 1 || !activeBoardId) {
      setActiveBoardId(newBoard.id);
    }
    setBoardMenuOpen(false);
  }

  async function handleBoardRename(id: string, currentTitle: string) {
    const title = window.prompt("新しいボード名", currentTitle);
    if (!title?.trim()) return;
    await renameBoard(id, title.trim());
    await reloadBoards();
    setBoardMenuOpen(false);
    setBoardSubMenu(null);
  }

  async function handleBoardDuplicate(id: string) {
    const src = boards.find((b) => b.id === id);
    const newBoard = await duplicateBoard(id, PROJECT_ID);
    await reloadBoards();
    setActiveBoardId(newBoard.id);
    setBoardMenuOpen(false);
    setBoardSubMenu(null);
    void src;
  }

  async function handleBoardDelete(id: string) {
    const board = boards.find((b) => b.id === id);
    if (!board) return;
    if (
      !window.confirm(
        `「${board.title}」を削除しますか？ボード上のデータも消えます。`,
      )
    )
      return;
    await deleteBoard(id);
    const remaining = await reloadBoards();
    if (activeBoardId === id) {
      setActiveBoardId(remaining[0]?.id ?? null);
    }
    setBoardMenuOpen(false);
    setBoardSubMenu(null);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderBottom: "1px solid var(--border)",
        background: "var(--sidebar-background)",
        color: "var(--foreground)",
        flexShrink: 0,
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      <span style={{ fontWeight: 600, marginRight: 4, fontSize: 13 }}>Map</span>

      {/* Board selector */}
      <div ref={boardMenuRef} style={{ position: "relative" }}>
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            setBoardMenuOpen((v) => !v);
            setBoardSubMenu(null);
          }}
          title="ボードを切り替え"
          className="max-w-[140px] overflow-hidden text-ellipsis"
        >
          <span className="truncate">{activeBoard?.title ?? "—"}</span>
          <span aria-hidden>▾</span>
        </Button>
        {boardMenuOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              zIndex: 50,
              minWidth: 180,
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              padding: "4px 0",
            }}
          >
            {boards.map((b) => (
              <div
                key={b.id}
                style={{ position: "relative" }}
                onMouseEnter={() => setBoardSubMenu(b.id)}
                onMouseLeave={() => setBoardSubMenu(null)}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "5px 12px",
                    background:
                      b.id === activeBoardId ? "var(--accent)" : "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--foreground)",
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    onClick={() => {
                      setActiveBoardId(b.id);
                      setBoardMenuOpen(false);
                    }}
                  >
                    {b.title}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: "var(--muted-foreground)",
                      marginLeft: 4,
                    }}
                  >
                    ⋯
                  </span>
                </div>
                {boardSubMenu === b.id && (
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      left: "100%",
                      zIndex: 51,
                      minWidth: 140,
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                      padding: "4px 0",
                    }}
                  >
                    <MenuButton
                      onClick={() => void handleBoardRename(b.id, b.title)}
                    >
                      リネーム
                    </MenuButton>
                    <MenuButton onClick={() => void handleBoardDuplicate(b.id)}>
                      複製
                    </MenuButton>
                    {boards.length > 1 && (
                      <MenuButton
                        destructive
                        onClick={() => void handleBoardDelete(b.id)}
                      >
                        削除
                      </MenuButton>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div
              style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }}
            />
            <MenuButton onClick={() => void handleBoardCreate()}>
              + 新規ボード
            </MenuButton>
          </div>
        )}
      </div>

      {/* Mode buttons */}
      <div style={{ display: "flex", gap: 2 }}>
        {MODES.map(({ key, label }) => {
          const active = mode === key;
          return (
            <Button
              key={key}
              variant={active ? "default" : "outline"}
              size="xs"
              onClick={() => setMode(key)}
              title={`${label} モード`}
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
        label="Scenes"
        checked={show.scenes}
        onChange={(v) => setShow({ scenes: v })}
      />
      <ShowCheckbox
        label="Codex"
        checked={show.codex}
        onChange={(v) => setShow({ codex: v })}
      />
      <ShowCheckbox
        label="Stickies"
        checked={show.stickies}
        onChange={(v) => setShow({ stickies: v })}
      />
      <ShowCheckbox
        label="Snippets"
        checked={show.snippets}
        onChange={(v) => setShow({ snippets: v })}
      />
      <ShowCheckbox
        label="Notes"
        checked={show.notes}
        onChange={(v) => setShow({ notes: v })}
      />
      <ShowCheckbox
        label="Edges"
        checked={show.derivedEdges}
        onChange={(v) => setShow({ derivedEdges: v })}
      />
      <ShowCheckbox
        label="User edges"
        checked={show.userEdges}
        onChange={(v) => setShow({ userEdges: v })}
      />
      <ShowCheckbox
        label="Frames"
        checked={show.frames}
        onChange={(v) => setShow({ frames: v })}
      />

      {/* ⋮ overflow menu */}
      <div ref={menuRef} style={{ position: "relative", marginLeft: "auto" }}>
        <Button
          variant="outline"
          size="xs"
          onClick={() => setMenuOpen((v) => !v)}
          title="メニュー"
        >
          ⋮
        </Button>
        {menuOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              zIndex: 50,
              minWidth: 200,
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              padding: "4px 0",
            }}
          >
            <SectionLabel>表示設定</SectionLabel>
            <MenuRow
              label="カラー"
              control={
                <select
                  value={colorBy}
                  onChange={(e) => setColorBy(e.target.value as ColorByAxis)}
                  style={menuSelectStyle}
                >
                  {COLOR_BY_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              }
            />
            <MenuRow
              label="テーマ"
              control={
                <select
                  value={visualTheme}
                  onChange={(e) =>
                    setVisualTheme(e.target.value as VisualTheme)
                  }
                  style={menuSelectStyle}
                >
                  {VISUAL_THEME_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              }
            />
            <MenuToggle
              label="ミニマップ"
              checked={minimapVisible}
              onChange={setMinimapVisible}
            />

            <div
              style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }}
            />

            <SectionLabel>自動配置</SectionLabel>
            {ARRANGE_ITEMS.map((item) => (
              <MenuButton
                key={item.type}
                onClick={() => {
                  setMenuOpen(false);
                  setPendingAutoArrange(item.type);
                }}
              >
                {item.label}
              </MenuButton>
            ))}

            <div
              style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }}
            />

            <SectionLabel>エクスポート</SectionLabel>
            {(
              [
                { type: "svg", label: "SVG として保存" },
                { type: "png", label: "PNG として保存" },
                { type: "json", label: "JSON としてエクスポート" },
              ] as const
            ).map((item) => (
              <MenuButton
                key={item.type}
                onClick={() => {
                  setMenuOpen(false);
                  setPendingExport(item.type);
                }}
              >
                {item.label}
              </MenuButton>
            ))}
          </div>
        )}
      </div>

      {/* Search button */}
      <Button
        variant="outline"
        size="xs"
        onClick={() => setSearchVisible(true)}
        title="ノードを検索 (Ctrl+F)"
      >
        🔍
      </Button>
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "4px 12px 2px",
        fontSize: 10,
        color: "var(--muted-foreground)",
        textTransform: "uppercase",
        letterSpacing: "0.05em",
      }}
    >
      {children}
    </div>
  );
}

const menuSelectStyle: React.CSSProperties = {
  fontSize: 11,
  border: "1px solid var(--border)",
  borderRadius: 3,
  background: "var(--background)",
  color: "var(--foreground)",
  padding: "1px 4px",
  cursor: "pointer",
};

function MenuButton({
  children,
  onClick,
  destructive,
}: {
  children: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      className="block h-auto w-full justify-start rounded-none px-3 py-1.5 text-left text-xs font-normal"
      style={destructive ? { color: "var(--destructive)" } : undefined}
    >
      {children}
    </Button>
  );
}

function MenuRow({
  label,
  control,
}: {
  label: string;
  control: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "4px 12px",
        fontSize: 12,
        color: "var(--foreground)",
        gap: 8,
      }}
    >
      <span>{label}</span>
      {control}
    </div>
  );
}

function MenuToggle({
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
        justifyContent: "space-between",
        padding: "4px 12px",
        fontSize: 12,
        color: "var(--foreground)",
        gap: 8,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <span>{label}</span>
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
    </label>
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
