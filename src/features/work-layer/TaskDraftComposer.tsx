import { Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface TaskDraftComposerProps {
  readonly focusId: string;
}

export function TaskDraftComposer({ focusId }: TaskDraftComposerProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [drafts, setDrafts] = useState<readonly string[]>([]);

  useEffect(() => {
    setOpen(false);
    setValue("");
    setDrafts([]);
  }, [focusId]);

  useEffect(() => {
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  const addDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = value.trim();
    if (title.length === 0) return;
    setDrafts((current) => [...current, title]);
    setValue("");
  };

  return (
    <div className="mt-2">
      {drafts.map((draft, index) => (
        <div
          key={`${focusId}-draft-${index}`}
          className="mt-1 flex items-center gap-2 rounded-sm border border-dashed border-foreground/30 px-3 py-2 text-xs"
        >
          <span aria-hidden="true" className="h-3 w-3 border border-border" />
          <span className="min-w-0 flex-1">{draft}</span>
          <span className="font-mono text-[8px] tracking-[0.1em] text-muted-foreground">
            {t("workLayer.tray.taskDraftNotSaved", "NOT SAVED")}
          </span>
        </div>
      ))}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t(
            "workLayer.tray.addTaskPreviewAria",
            "この作業にタスクを追加 · PREVIEW ONLY",
          )}
          className="mt-2 flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" />
          {t("workLayer.tray.addTask", "この作業にタスクを追加")}
          <span className="font-mono text-[8px] tracking-[0.1em]">
            {t("workLayer.tray.previewOnly", "PREVIEW ONLY")}
          </span>
        </button>
      ) : (
        <form
          onSubmit={addDraft}
          className="mt-2 rounded-sm border border-dashed border-foreground/30 p-2"
        >
          <div className="flex items-center gap-2">
            <label
              htmlFor={`work-layer-task-draft-${focusId}`}
              className="sr-only"
            >
              {t("workLayer.tray.taskDraftLabel", "タスクの下書き")}
            </label>
            <input
              ref={inputRef}
              id={`work-layer-task-draft-${focusId}`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t(
                "workLayer.tray.taskDraftPlaceholder",
                "作者タスクを入力",
              )}
              className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="submit"
              disabled={value.trim().length === 0}
              className="rounded-sm bg-foreground px-2 py-1.5 text-xs text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("workLayer.tray.addTaskDraft", "下書きを追加")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
              aria-label={t("workLayer.tray.cancelTaskDraft", "下書きを閉じる")}
              className="rounded-sm p-1.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground">
            {t(
              "workLayer.tray.taskDraftPreviewNote",
              "この下書きはUIだけに表示され、保存されません。",
            )}
          </p>
        </form>
      )}
    </div>
  );
}
