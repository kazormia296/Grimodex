import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";

export interface CreateProjectFormData {
  title: string;
  genre: string;
  language: string;
}

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: CreateProjectFormData) => Promise<void>;
}

const LANGUAGE_OPTIONS = [
  { value: "ja", label: "日本語" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ko", label: "한국어" },
];

const GENRE_OPTIONS = [
  "",
  "Fantasy",
  "Sci-Fi",
  "Mystery",
  "Horror",
  "Romance",
  "Thriller",
  "Literary",
  "Historical",
  "Other",
];

export function CreateProjectDialog({
  open,
  onClose,
  onCreate,
}: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("ja");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setGenre("");
      setLanguage("ja");
      setIsSaving(false);
    }
  }, [open]);

  const canSave = title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onCreate({ title: title.trim(), genre, language });
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSave();
    if (e.key === "Escape") onClose();
  };

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      testId="create-project-dialog"
    >
      <h3 className="mb-4 text-sm font-semibold text-foreground">
        {t("project.create.heading")}
      </h3>

      <div className="space-y-3" onKeyDown={handleKeyDown}>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("project.create.titleLabel")}
          </label>
          <input
            data-testid="project-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("project.create.titlePlaceholder")}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("project.create.genreLabel")}
          </label>
          <select
            data-testid="project-genre-select"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {GENRE_OPTIONS.map((value) => (
              <option key={value || "unset"} value={value}>
                {value || t("settings.project.unselected")}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("project.create.languageLabel")}
          </label>
          <select
            data-testid="project-language-select"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {LANGUAGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="project-create-submit"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {isSaving ? t("common.loading") : t("common.create")}
          </button>
        </div>
      </div>
    </AnimatedOverlay>
  );
}
