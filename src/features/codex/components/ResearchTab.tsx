import { useTranslation } from "react-i18next";
import { CodexContentEditor } from "./CodexContentEditor";

interface ResearchTabProps {
  notes: string;
  onNotesChange: (notes: string) => void;
}

export function ResearchTab({ notes, onNotesChange }: ResearchTabProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium">
          {t("codex.research.notesLabel")}
          <span className="ml-1 text-[10px] text-muted-foreground">
            ({t("codex.research.notInContext")})
          </span>
        </label>
        <CodexContentEditor content={notes} onContentChange={onNotesChange} />
      </div>
    </div>
  );
}
