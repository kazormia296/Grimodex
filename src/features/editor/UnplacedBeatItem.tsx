import { useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { GripVertical, MoreVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { createUnplacedBeatExtensions } from "@/features/editor/beat/createUnplacedBeatExtensions";
import { placeBeatAtEnd } from "@/features/editor/beat/beatOperations";
import { generateBeatOnce } from "@/features/editor/beat/generateBeatOnce";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { BEAT_TYPES } from "@/features/editor/SceneBeatNode";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";
import type { Editor as TiptapEditor } from "@tiptap/core";

interface UnplacedBeatItemProps {
  sceneId: string;
  beat: UnplacedBeat;
  mainEditor: TiptapEditor | null;
  setMentionPopup: (state: CodexMentionPopupState | null) => void;
}

export function UnplacedBeatItem({
  sceneId,
  beat,
  mainEditor,
  setMentionPopup,
}: UnplacedBeatItemProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeMenuRef = useRef<HTMLDivElement>(null);

  const updateBeat = useUnplacedBeatsStore((s) => s.updateBeat);
  const removeBeat = useUnplacedBeatsStore((s) => s.removeBeat);
  const addBeat = useUnplacedBeatsStore((s) => s.addBeat);

  const handleUpdate = useCallback(
    ({
      editor: ed,
    }: {
      editor: {
        state: {
          doc: {
            firstChild: { content: { toJSON: () => unknown[] | null } } | null;
          };
        };
      };
    }) => {
      const firstChild = ed.state.doc.firstChild;
      // Fragment.toJSON() returns null when the fragment is empty; normalise to [].
      const content = firstChild ? (firstChild.content.toJSON() ?? []) : [];
      updateBeat(sceneId, beat.id, {
        content: content as UnplacedBeat["content"],
      });
    },
    [sceneId, beat.id, updateBeat],
  );

  const extensions = createUnplacedBeatExtensions(setMentionPopup);

  const editor = useEditor({
    extensions,
    content: beat.content?.length
      ? { type: "doc", content: [{ type: "paragraph", content: beat.content }] }
      : { type: "doc", content: [{ type: "paragraph" }] },
    onUpdate: handleUpdate,
  });

  const handlePlaceAtEnd = useCallback(() => {
    if (mainEditor) placeBeatAtEnd(mainEditor, sceneId, beat);
    setMenuOpen(false);
  }, [mainEditor, sceneId, beat]);

  const handlePlaceAtEndAndGenerate = useCallback(() => {
    setMenuOpen(false);
    if (!mainEditor) return;
    placeBeatAtEnd(mainEditor, sceneId, beat);
    void generateBeatOnce(mainEditor, beat.id, sceneId);
  }, [mainEditor, sceneId, beat]);

  const handleDuplicate = useCallback(() => {
    addBeat(sceneId, { ...beat, id: crypto.randomUUID() });
    setMenuOpen(false);
  }, [addBeat, beat, sceneId]);

  const handleDelete = useCallback(() => {
    removeBeat(sceneId, beat.id);
    setMenuOpen(false);
  }, [removeBeat, sceneId, beat.id]);

  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: beat.id,
    data: { beat, sceneId },
  });

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setSortableRef}
      style={sortableStyle}
      className={`group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted/40 ${isDragging ? "opacity-50" : ""}`}
      data-beat-id={beat.id}
    >
      {/* Drag handle */}
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label="Drag to reorder"
        className="inline-flex h-4 cursor-grab items-center justify-center rounded px-0.5 text-muted-foreground/40 opacity-0 hover:bg-muted hover:text-muted-foreground group-hover:opacity-100 active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-2.5 w-2.5" />
      </button>

      {/* Beat type chip */}
      <div ref={typeMenuRef} className="relative flex-shrink-0">
        <button
          type="button"
          data-testid={`unplaced-beat-type-chip-${beat.id}`}
          data-beat-type={beat.beatType}
          onClick={() => setTypeMenuOpen((v) => !v)}
          className="inline-flex h-4 items-center rounded bg-muted px-1 text-[10px] uppercase leading-none tracking-wide hover:bg-muted/80"
        >
          {t(`editor.beat.types.${beat.beatType}`, beat.beatType)}
        </button>
        <AnimatedDropdown
          open={typeMenuOpen}
          onClose={() => setTypeMenuOpen(false)}
          containerRef={typeMenuRef}
          className="absolute left-0 top-5 z-50 min-w-[110px] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          <ul role="menu" className="text-xs">
            {BEAT_TYPES.map((bt) => (
              <li key={bt}>
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`unplaced-beat-type-option-${beat.id}-${bt}`}
                  onClick={() => {
                    updateBeat(sceneId, beat.id, { beatType: bt });
                    setTypeMenuOpen(false);
                  }}
                  className={`block w-full px-3 py-1.5 text-left uppercase tracking-wide hover:bg-primary hover:text-primary-foreground ${bt === beat.beatType ? "font-medium" : ""}`}
                >
                  {t(`editor.beat.types.${bt}`, bt)}
                </button>
              </li>
            ))}
          </ul>
        </AnimatedDropdown>
      </div>

      <div className="min-w-0 flex-1">
        <EditorContent
          editor={editor}
          className="beat-inline-editor text-xs leading-relaxed text-foreground [&_.ProseMirror]:min-h-[1.5em] [&_.ProseMirror]:outline-none"
        />
      </div>

      <div ref={menuContainerRef} className="relative flex-shrink-0">
        <button
          type="button"
          data-testid={`beat-item-menu-${beat.id}`}
          onClick={() => setMenuOpen((v) => !v)}
          className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
        <AnimatedDropdown
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          containerRef={menuContainerRef}
          className="absolute right-0 top-5 z-50 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          <ul role="menu" className="text-xs">
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  editor?.commands.focus();
                  setMenuOpen(false);
                }}
                className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground"
              >
                Edit
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                data-testid={`beat-menu-place-at-end-${beat.id}`}
                disabled={!mainEditor}
                onClick={handlePlaceAtEnd}
                className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
              >
                Place at end of document
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                data-testid={`beat-menu-place-and-generate-${beat.id}`}
                disabled={!mainEditor}
                onClick={handlePlaceAtEndAndGenerate}
                className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
              >
                Place at end and generate
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={handleDuplicate}
                className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground"
              >
                Duplicate
              </button>
            </li>
            <li>
              <button
                type="button"
                role="menuitem"
                data-testid={`beat-menu-delete-${beat.id}`}
                onClick={handleDelete}
                className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-primary hover:text-primary-foreground dark:text-red-400"
              >
                Delete
              </button>
            </li>
          </ul>
        </AnimatedDropdown>
      </div>
    </div>
  );
}
