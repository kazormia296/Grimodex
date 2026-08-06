from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(relative_path: str, old: str, new: str) -> None:
    path = ROOT / relative_path
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(
            f"expected exactly one match in {relative_path}, found {count}: {old[:80]!r}"
        )
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


card_path = "src/features/editor/stickies/EditorStickyCard.tsx"
surface_path = "src/features/editor/stickies/EditorStickySurface.tsx"
card_test_path = "src/features/editor/stickies/EditorStickyCard.test.tsx"

replace_once(
    card_path,
    '''import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
''',
    '''import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
''',
)

replace_once(
    card_path,
    '  onSelect: (stickyId: string) => void;\n',
    '  onSelect: (stickyId: string | null) => void;\n',
)

replace_once(
    card_path,
    '  onColorChange: (sticky: EditorSticky) => Promise<void>;\n',
    '''  onColorChange: (
    sticky: EditorSticky,
    paletteId: string,
    colorSlot: number,
  ) => Promise<void>;
''',
)

replace_once(
    card_path,
    '''}: EditorStickyCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [glueOrient, setGlueOrient] = useState<StickyGlueOrientation>("left");
''',
    '''}: EditorStickyCardProps) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [glueOrient, setGlueOrient] = useState<StickyGlueOrientation>("left");
''',
)

replace_once(
    card_path,
    '''  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [menu]);

''',
    '',
)

replace_once(
    card_path,
    '''  const paperColor = resolveStickyHex(sticky.paletteId, sticky.colorSlot);
  const rotation = stickyRotation(sticky.id);
''',
    '''  const palette = getPalette(sticky.paletteId);
  const paperColor = resolveStickyHex(sticky.paletteId, sticky.colorSlot);
  const rotation = stickyRotation(sticky.id);
''',
)

replace_once(
    card_path,
    '''  return (
    <div
''',
    '''  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onSelect(sticky.id);
      }}
    >
      <ContextMenuTrigger asChild>
        <div
''',
)

replace_once(
    card_path,
    '''      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onSelect(sticky.id);
        setMenu({ x: event.clientX, y: event.clientY });
      }}
''',
    '''      onContextMenu={(event) => {
        event.stopPropagation();
        onSelect(sticky.id);
      }}
''',
)

replace_once(
    card_path,
    '''          if (editing) leaveEditing();
          else onSelect(sticky.id);
''',
    '''          if (editing) leaveEditing();
          else onSelect(null);
''',
)

replace_once(
    card_path,
    '''      {menu
        ? createPortal(
            <div
              className="editor-sticky-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                onClick={() =>
                  void onColorChange(sticky)
                    .catch(() => toast.error("付箋の色を変更できませんでした"))
                    .finally(() => setMenu(null))
                }
              >
                色を変更
              </button>
              <button
                type="button"
                onClick={() =>
                  void onBringToFront(sticky)
                    .catch(() =>
                      toast.error("付箋を前面へ移動できませんでした"),
                    )
                    .finally(() => setMenu(null))
                }
              >
                前面へ
              </button>
              <button
                type="button"
                onClick={() =>
                  void onSendToBack(sticky)
                    .catch(() =>
                      toast.error("付箋を背面へ移動できませんでした"),
                    )
                    .finally(() => setMenu(null))
                }
              >
                背面へ
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleDelete()
                    .catch(() => toast.error("付箋を削除できませんでした"))
                    .finally(() => setMenu(null))
                }
              >
                削除
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

export function nextStickyColor(sticky: EditorSticky): {
  paletteId: string;
  colorSlot: number;
} {
  const palette = getPalette(sticky.paletteId);
  return {
    paletteId: palette.id,
    colorSlot: (sticky.colorSlot + 1) % palette.colors.length,
  };
}
''',
    '''    </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[180px]"
        data-editor-sticky-menu={sticky.id}
      >
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {t("map.menu.changeColor")}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            className="min-w-[160px]"
            data-editor-sticky-menu={sticky.id}
          >
            {palette.colors.map((color, slot) => (
              <ContextMenuItem
                key={slot}
                onSelect={() => {
                  void onColorChange(sticky, palette.id, slot).catch(() =>
                    toast.error("付箋の色を変更できませんでした"),
                  );
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    border: "1.5px solid rgba(0,0,0,0.2)",
                    background: color.hex,
                    flexShrink: 0,
                    marginRight: 8,
                  }}
                />
                <span>{color.label}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            void onBringToFront(sticky).catch(() =>
              toast.error("付箋を前面へ移動できませんでした"),
            );
          }}
        >
          {t("map.menu.bringToFront")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            void onSendToBack(sticky).catch(() =>
              toast.error("付箋を背面へ移動できませんでした"),
            );
          }}
        >
          {t("map.menu.sendToBack")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => {
            void handleDelete().catch(() =>
              toast.error("付箋を削除できませんでした"),
            );
          }}
        >
          {t("common.delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
''',
)

replace_once(
    surface_path,
    'import { EditorStickyCard, nextStickyColor } from "./EditorStickyCard";\n',
    '''import { EditorStickyCard } from "./EditorStickyCard";
import { shouldKeepEditorStickySelection } from "./editorStickySelection";
''',
)

replace_once(
    surface_path,
    '''  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragPositions, setDragPositions] = useState<
''',
    '''  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId === null) return;
    const clearSelection = (event: PointerEvent) => {
      if (
        shouldKeepEditorStickySelection(
          surfaceRef.current,
          event.target,
          selectedId,
        )
      ) {
        return;
      }
      setSelectedId(null);
    };
    document.addEventListener("pointerdown", clearSelection, true);
    return () =>
      document.removeEventListener("pointerdown", clearSelection, true);
  }, [selectedId]);

  const [dragPositions, setDragPositions] = useState<
''',
)

replace_once(
    surface_path,
    '''  const handleColorChange = useCallback(
    async (sticky: EditorSticky) => {
      await updateSticky(sticky, nextStickyColor(sticky));
    },
    [updateSticky],
  );
''',
    '''  const handleColorChange = useCallback(
    async (sticky: EditorSticky, paletteId: string, colorSlot: number) => {
      await updateSticky(sticky, { paletteId, colorSlot });
    },
    [updateSticky],
  );
''',
)

selection_source = '''export function shouldKeepEditorStickySelection(
  surface: HTMLElement | null,
  target: EventTarget | null,
  selectedId: string | null,
): boolean {
  if (!selectedId || !(target instanceof Node)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  const menu = element?.closest("[data-editor-sticky-menu]");
  if (menu?.getAttribute("data-editor-sticky-menu") === selectedId) return true;
  return Boolean(
    surface?.contains(target) &&
      element?.closest('[data-editor-sticky-card="true"]'),
  );
}
'''
(ROOT / "src/features/editor/stickies/editorStickySelection.ts").write_text(
    selection_source,
    encoding="utf-8",
)

selection_test_source = '''// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { shouldKeepEditorStickySelection } from "./editorStickySelection";

describe("shouldKeepEditorStickySelection", () => {
  it("keeps selection for the active surface card and its portaled menu", () => {
    const surface = document.createElement("div");
    const card = document.createElement("div");
    const body = document.createElement("span");
    card.dataset.editorStickyCard = "true";
    card.append(body);
    surface.append(card);

    const menu = document.createElement("div");
    const menuItem = document.createElement("button");
    menu.dataset.editorStickyMenu = "sticky-1";
    menu.append(menuItem);

    expect(
      shouldKeepEditorStickySelection(surface, body, "sticky-1"),
    ).toBe(true);
    expect(
      shouldKeepEditorStickySelection(surface, menuItem, "sticky-1"),
    ).toBe(true);
  });

  it("clears selection for editor content, another surface, and another menu", () => {
    const surface = document.createElement("div");
    const editorBody = document.createElement("div");
    surface.append(editorBody);

    const otherCard = document.createElement("div");
    otherCard.dataset.editorStickyCard = "true";
    const otherMenu = document.createElement("div");
    otherMenu.dataset.editorStickyMenu = "sticky-2";

    expect(
      shouldKeepEditorStickySelection(surface, editorBody, "sticky-1"),
    ).toBe(false);
    expect(
      shouldKeepEditorStickySelection(surface, otherCard, "sticky-1"),
    ).toBe(false);
    expect(
      shouldKeepEditorStickySelection(surface, otherMenu, "sticky-1"),
    ).toBe(false);
  });
});
'''
(ROOT / "src/features/editor/stickies/editorStickySelection.test.ts").write_text(
    selection_test_source,
    encoding="utf-8",
)

interaction_tests = '''

  it("executes commands from the Map-style context menu", async () => {
    const onBringToFront = vi.fn().mockResolvedValue(undefined);
    renderCard({ editing: false, onBringToFront });

    fireEvent.contextMenu(screen.getByLabelText("Editor付箋"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "前面へ" }),
    );

    await waitFor(() =>
      expect(onBringToFront).toHaveBeenCalledExactlyOnceWith(sticky),
    );
  });

  it("opens the color submenu and applies the selected palette slot", async () => {
    const onColorChange = vi.fn().mockResolvedValue(undefined);
    renderCard({ editing: false, onColorChange });

    fireEvent.contextMenu(screen.getByLabelText("Editor付箋"));
    const colorTrigger = await screen.findByRole("menuitem", {
      name: "色を変更",
    });
    fireEvent.keyDown(colorTrigger, { key: "ArrowRight" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Vital Orange" }),
    );

    await waitFor(() =>
      expect(onColorChange).toHaveBeenCalledExactlyOnceWith(
        sticky,
        "post-it-playful",
        1,
      ),
    );
  });

  it("clears the selected state with Escape outside edit mode", () => {
    const { onSelect } = renderCard({ editing: false });

    fireEvent.keyDown(screen.getByLabelText("Editor付箋"), { key: "Escape" });

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(null);
  });
'''

replace_once(
    card_test_path,
    '\n});\n\ndescribe("EditorStickyCard edit authority", () => {',
    interaction_tests
    + '\n});\n\ndescribe("EditorStickyCard edit authority", () => {',
)

# Remove the one-shot bootstrap artifacts so the resulting branch contains
# only the product fix and its regression coverage.
(ROOT / ".github/agent/apply_editor_sticky_fix.py").unlink()
(ROOT / ".github/workflows/apply-editor-sticky-fix.yml").unlink()
