import { useState, useEffect, useCallback, useRef } from "react";
import type { Editor } from "@tiptap/core";
import type { AuthorshipSource } from "./AuthorshipMark";
import { useAttributionStore } from "./attributionStore";

interface MenuPosition {
  x: number;
  y: number;
}

const SOURCE_OPTIONS: { value: AuthorshipSource; label: string }[] = [
  { value: "human", label: "人間" },
  { value: "ai", label: "AI生成" },
  { value: "unknown", label: "不明" },
  { value: "snippet", label: "スニペット" },
];

export function AttributionOverrideMenu({ editor }: { editor: Editor | null }) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const showAttribution = useAttributionStore((s) => s.showAttribution);

  const close = useCallback(() => setPosition(null), []);

  useEffect(() => {
    if (!editor || !showAttribution) return;

    const editorDom = editor.view.dom;

    const handleContextMenu = (e: MouseEvent) => {
      const { from, to, empty } = editor.state.selection;
      if (empty) return;

      // Check if selection contains authorship marks
      let hasAuthorship = false;
      editor.state.doc.nodesBetween(from, to, (node) => {
        if (
          node.isText &&
          node.marks.some((m) => m.type.name === "authorship")
        ) {
          hasAuthorship = true;
        }
      });

      if (!hasAuthorship) return;

      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
    };

    editorDom.addEventListener("contextmenu", handleContextMenu);
    return () =>
      editorDom.removeEventListener("contextmenu", handleContextMenu);
  }, [editor, showAttribution]);

  // Close on click outside
  useEffect(() => {
    if (!position) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [position, close]);

  const handleOverride = useCallback(
    (newSource: AuthorshipSource) => {
      if (!editor) return;

      const { from, to } = editor.state.selection;
      const authorshipType = editor.schema.marks["authorship"];
      if (!authorshipType) return;

      const mark = authorshipType.create({
        source: newSource,
        manualOverride: true,
        timestamp: new Date().toISOString(),
      });

      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.addMark(from, to, mark);
          return true;
        })
        .run();

      close();
    },
    [editor, close],
  );

  if (!position) return null;

  return (
    <div
      ref={menuRef}
      data-testid="attribution-override-menu"
      className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
        帰属を変更
      </div>
      {SOURCE_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          data-testid={`override-${opt.value}`}
          onClick={() => handleOverride(opt.value)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
