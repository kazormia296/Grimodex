import { useState, useEffect, useCallback } from "react";
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
import { ChevronDown, MoreVertical } from "lucide-react";
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

const EXPORT_ITEMS = [
  { type: "svg", label: "SVG として保存" },
  { type: "png", label: "PNG として保存" },
  { type: "json", label: "JSON としてエクスポート" },
] as const;

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

  const reloadBoards = useCallback(async () => {
    const all = await listBoards(PROJECT_ID);
    setBoards(all);
    return all;
  }, []);

  useEffect(() => {
    reloadBoards().catch(console.error);
  }, [reloadBoards, activeBoardId]);

  async function handleBoardCreate() {
    const title = window.prompt("ボード名を入力", "新規ボード");
    if (!title?.trim()) return;
    const newBoard = await createBoard(PROJECT_ID, title.trim());
    const all = await reloadBoards();
    if (all.length === 1 || !activeBoardId) {
      setActiveBoardId(newBoard.id);
    }
  }

  async function handleBoardRename(id: string, currentTitle: string) {
    const title = window.prompt("新しいボード名", currentTitle);
    if (!title?.trim()) return;
    await renameBoard(id, title.trim());
    await reloadBoards();
  }

  async function handleBoardDuplicate(id: string) {
    const newBoard = await duplicateBoard(id, PROJECT_ID);
    await reloadBoards();
    setActiveBoardId(newBoard.id);
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            title="ボードを切り替え"
            className="max-w-[140px] overflow-hidden"
          >
            <span className="truncate">{activeBoard?.title ?? "—"}</span>
            <ChevronDown className="ml-1 h-3 w-3" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          {boards.map((b) => (
            <DropdownMenuItem
              key={b.id}
              onSelect={() => setActiveBoardId(b.id)}
              className={b.id === activeBoardId ? "bg-accent" : undefined}
            >
              <span className="truncate">{b.title}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!activeBoard}>
              アクティブボード操作
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                disabled={!activeBoard}
                onSelect={() => {
                  if (!activeBoard) return;
                  void handleBoardRename(activeBoard.id, activeBoard.title);
                }}
              >
                リネーム
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!activeBoard}
                onSelect={() => {
                  if (!activeBoard) return;
                  void handleBoardDuplicate(activeBoard.id);
                }}
              >
                複製
              </DropdownMenuItem>
              {boards.length > 1 && activeBoard && (
                <DropdownMenuItem
                  onSelect={() => void handleBoardDelete(activeBoard.id)}
                  className="text-[color:var(--destructive)] focus:text-[color:var(--destructive)]"
                >
                  削除
                </DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => void handleBoardCreate()}>
            + 新規ボード
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
      <div style={{ marginLeft: "auto" }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              title="メニュー"
              aria-label="メニュー"
            >
              <MoreVertical className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[200px]">
            <DropdownMenuItem onSelect={() => setSearchVisible(true)}>
              ノードを検索
              <DropdownMenuShortcut>Ctrl+F</DropdownMenuShortcut>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuLabel>表示設定</DropdownMenuLabel>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>カラー</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={colorBy}
                  onValueChange={(v) => setColorBy(v as ColorByAxis)}
                >
                  {COLOR_BY_OPTIONS.map(({ value, label }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>テーマ</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={visualTheme}
                  onValueChange={(v) => setVisualTheme(v as VisualTheme)}
                >
                  {VISUAL_THEME_OPTIONS.map(({ value, label }) => (
                    <DropdownMenuRadioItem key={value} value={value}>
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuCheckboxItem
              checked={minimapVisible}
              onCheckedChange={(v) => setMinimapVisible(v === true)}
            >
              ミニマップ
            </DropdownMenuCheckboxItem>

            <DropdownMenuSeparator />

            <DropdownMenuLabel>自動配置</DropdownMenuLabel>
            {ARRANGE_ITEMS.map((item) => (
              <DropdownMenuItem
                key={item.type}
                onSelect={() => setPendingAutoArrange(item.type)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />

            <DropdownMenuLabel>エクスポート</DropdownMenuLabel>
            {EXPORT_ITEMS.map((item) => (
              <DropdownMenuItem
                key={item.type}
                onSelect={() => setPendingExport(item.type)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
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
