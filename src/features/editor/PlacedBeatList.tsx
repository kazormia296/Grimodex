import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";

interface PlacedBeatEntry {
  id: string;
  pos: number;
  preview: string;
}

interface PlacedBeatListProps {
  editor: Editor | null;
}

function collectPlacedBeats(editor: Editor | null): PlacedBeatEntry[] {
  if (!editor) return [];
  const beats: PlacedBeatEntry[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "sceneBeat") {
      const preview = node.textContent.slice(0, 40);
      beats.push({ id: node.attrs.id as string, pos, preview });
      return false;
    }
    return true;
  });
  return beats;
}

export function PlacedBeatList({ editor }: PlacedBeatListProps) {
  const { t } = useTranslation();
  const [beats, setBeats] = useState<PlacedBeatEntry[]>(() =>
    collectPlacedBeats(editor),
  );

  useEffect(() => {
    if (!editor) return;
    setBeats(collectPlacedBeats(editor));
    const handler = () => setBeats(collectPlacedBeats(editor));
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor]);

  if (beats.length === 0) return null;

  return (
    <div className="mt-1">
      <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
        {t("editor.beat.panel.placedHeading")}
      </p>
      <ul className="space-y-0.5">
        {beats.map((beat) => (
          <li key={beat.id}>
            <button
              type="button"
              onClick={() => {
                if (!editor) return;
                editor.commands.focus();
                editor.commands.setTextSelection(beat.pos + 1);
                editor.commands.scrollIntoView();
              }}
              className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <span className="text-[10px] opacity-50">┃</span>
              <span className="min-w-0 flex-1 truncate">
                {beat.preview || (
                  <em className="opacity-50">
                    {t("editor.beat.panel.emptyBeat")}
                  </em>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
