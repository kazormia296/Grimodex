import { useCallback, useState } from "react";
import type { UnplacedBeat } from "@/features/editor/beat/unplacedBeatsStore";
import { ChevronDown, ChevronRight, Plus, Sparkles } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { useDroppable } from "@dnd-kit/core";
import { useUnplacedBeatsStore } from "@/features/editor/beat/unplacedBeatsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { UnplacedBeatItem } from "@/features/editor/UnplacedBeatItem";
import { PlacedBeatList } from "@/features/editor/PlacedBeatList";
import { generateBeatsFromSynopsis } from "@/features/editor/beat/generateBeatsFromSynopsis";
import { useTranslation } from "react-i18next";
import type { CodexMentionPopupState } from "@/features/codex/CodexMentionExtension";

interface BeatsHeaderProps {
  sceneId: string;
  editor: Editor | null;
  setMentionPopup: (state: CodexMentionPopupState | null) => void;
}

function countPlacedBeats(editor: Editor | null): number {
  if (!editor) return 0;
  let count = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "sceneBeat") {
      count++;
      return false;
    }
    return true;
  });
  return count;
}

// 安定した空配列の参照（Zustand selector が毎回 [] を生成すると無限 re-render になる）
const EMPTY_BEATS: UnplacedBeat[] = [];

export function BeatsHeader({
  sceneId,
  editor,
  setMentionPopup,
}: BeatsHeaderProps) {
  const { t } = useTranslation();
  const beats = useUnplacedBeatsStore(
    (s) => s.sceneBeats[sceneId] ?? EMPTY_BEATS,
  );
  const addBeat = useUnplacedBeatsStore((s) => s.addBeat);

  const placedCount = countPlacedBeats(editor);

  const synopsis = useTreeStore(
    (s) => s.nodes.find((n) => n.id === sceneId)?.synopsis ?? "",
  );
  const hasSynopsis = synopsis.trim().length > 0;

  const { setNodeRef: setUnplacedDropRef, isOver: isOverUnplaced } =
    useDroppable({ id: "unplaced-drop-zone" });

  const [collapsed, setCollapsed] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleAddBeat = useCallback(() => {
    addBeat(sceneId, {
      id: crypto.randomUUID(),
      beatType: "free",
      pov: null,
      collapsed: false,
      content: [],
    });
    if (collapsed) setCollapsed(false);
  }, [addBeat, sceneId, collapsed]);

  const handleGenerateFromSynopsis = useCallback(() => {
    setIsGenerating(true);
    if (collapsed) setCollapsed(false);
    generateBeatsFromSynopsis(sceneId, {
      onDone: () => setIsGenerating(false),
      onError: (msg) => {
        setIsGenerating(false);
        toast.error(msg);
      },
    });
  }, [sceneId, collapsed]);

  const badge = [
    beats.length > 0 ? `${beats.length} unplaced` : null,
    placedCount > 0 ? `${placedCount} placed` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="flex-shrink-0 border-b border-border bg-muted/30"
      data-testid="beats-header"
    >
      <div className="flex items-center gap-1 px-3 py-1.5">
        <button
          type="button"
          data-testid="beats-header-toggle"
          onClick={() => setCollapsed((v) => !v)}
          className="flex flex-1 items-center gap-1 text-left"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          )}
          <span className="text-[11px] font-medium text-muted-foreground">
            Beats
          </span>
          {badge && (
            <span
              data-testid="beats-count-badge"
              className="text-[10px] text-muted-foreground/70"
            >
              {badge}
            </span>
          )}
        </button>
        {hasSynopsis && (
          <button
            type="button"
            data-testid="beats-generate-from-synopsis"
            onClick={handleGenerateFromSynopsis}
            disabled={isGenerating}
            title={t("editor.beat.generateFromSynopsis")}
            className="rounded p-0.5 hover:bg-muted disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3 text-muted-foreground" />
          </button>
        )}
        <button
          type="button"
          data-testid="beats-add-button"
          onClick={handleAddBeat}
          title="Add beat"
          className="rounded p-0.5 hover:bg-muted"
        >
          <Plus className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>

      {!collapsed && (
        <div className="px-2 pb-2">
          {isGenerating && (
            <p className="mb-1 text-[10px] italic text-muted-foreground/70">
              {t("editor.beat.generatingFromSynopsis")}
            </p>
          )}
          <div
            ref={setUnplacedDropRef}
            data-testid="beats-unplaced-drop-zone"
            className={`mb-1 rounded transition-colors ${isOverUnplaced ? "bg-accent/30 ring-1 ring-accent" : ""}`}
          >
            {beats.length > 0 ? (
              <>
                <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                  📌 Unplaced (drag to insert in document):
                </p>
                <ul data-testid="beats-unplaced-list" className="space-y-0.5">
                  {beats.map((beat) => (
                    <li key={beat.id}>
                      <UnplacedBeatItem
                        sceneId={sceneId}
                        beat={beat}
                        mainEditor={editor}
                        setMentionPopup={setMentionPopup}
                      />
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p
                className={`py-1 text-[10px] italic text-muted-foreground/60 ${isOverUnplaced ? "text-accent-foreground/70" : ""}`}
              >
                Drop beat here to unplace
              </p>
            )}
          </div>

          {beats.length === 0 && placedCount === 0 && (
            <p className="text-[10px] text-muted-foreground/60 italic">
              No beats yet. Click + to add your first beat.
            </p>
          )}

          <PlacedBeatList editor={editor} />
        </div>
      )}
    </div>
  );
}
