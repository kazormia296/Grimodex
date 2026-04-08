import { CodexContentEditor } from "./CodexContentEditor";

interface ResearchTabProps {
  notes: string;
  onNotesChange: (notes: string) => void;
}

export function ResearchTab({ notes, onNotesChange }: ResearchTabProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium">
          Notes
          <span className="ml-1 text-[10px] text-muted-foreground">
            (AIコンテキストに含まれません)
          </span>
        </label>
        <CodexContentEditor content={notes} onContentChange={onNotesChange} />
      </div>
    </div>
  );
}
