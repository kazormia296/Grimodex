import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import type { Project } from "./api";
import { listCodexTypes, type CodexType } from "@/features/codex/typeApi";

export interface CreateProjectFormData {
  title: string;
  genre: string;
  language: string;
  seedFromProjectId?: string;
  seedTypeSlugs: string[];
}

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  defaultSourceProjectId: string;
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
  projects,
  defaultSourceProjectId,
  onCreate,
}: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState("ja");
  const [seedFromProjectId, setSeedFromProjectId] = useState(
    defaultSourceProjectId,
  );
  const [availableTypes, setAvailableTypes] = useState<CodexType[]>([]);
  const [selectedTypeSlugs, setSelectedTypeSlugs] = useState<Set<string>>(
    new Set(),
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setGenre("");
      setLanguage("ja");
      setSeedFromProjectId(defaultSourceProjectId);
      setSelectedTypeSlugs(new Set());
      setIsSaving(false);
    }
  }, [open, defaultSourceProjectId]);

  useEffect(() => {
    if (!open || !seedFromProjectId) {
      setAvailableTypes([]);
      return;
    }
    let cancelled = false;
    void listCodexTypes(seedFromProjectId).then((types) => {
      if (!cancelled) setAvailableTypes(types);
    });
    return () => {
      cancelled = true;
    };
  }, [open, seedFromProjectId]);

  const canSave = title.trim().length > 0 && !isSaving;

  const toggleTypeSlug = (slug: string) => {
    setSelectedTypeSlugs((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      await onCreate({
        title: title.trim(),
        genre,
        language,
        seedFromProjectId:
          selectedTypeSlugs.size > 0 ? seedFromProjectId : undefined,
        seedTypeSlugs: [...selectedTypeSlugs],
      });
      onClose();
    } catch {
      // onCreate 側でトースト表示済み。ダイアログは開いたまま再入力を待つ。
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

        {projects.length > 0 && (
          <div className="rounded-md border border-border p-3">
            <p className="mb-2 text-xs font-medium text-foreground">
              {t("project.create.seedHeading")}
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              {t("project.create.seedDescription")}
            </p>

            <label className="mb-1 block text-xs text-muted-foreground">
              {t("project.create.seedSourceLabel")}
            </label>
            <select
              data-testid="project-seed-source-select"
              value={seedFromProjectId}
              onChange={(e) => {
                setSeedFromProjectId(e.target.value);
                setSelectedTypeSlugs(new Set());
              }}
              className="mb-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>

            {availableTypes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("project.create.seedNoTypes")}
              </p>
            ) : (
              <div
                data-testid="project-seed-type-list"
                className="max-h-36 space-y-1 overflow-y-auto"
              >
                {availableTypes.map((type) => (
                  <label
                    key={type.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/50"
                  >
                    <input
                      type="checkbox"
                      data-testid={`project-seed-type-${type.slug}`}
                      checked={selectedTypeSlugs.has(type.slug)}
                      onChange={() => toggleTypeSlug(type.slug)}
                    />
                    <span>{type.label}</span>
                    <span className="text-xs text-muted-foreground">
                      ({type.slug})
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

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
