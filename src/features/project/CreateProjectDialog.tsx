import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import type { Project } from "./api";
import { GENRE_VALUES } from "./genreOptions";
import { listCodexTypes, type CodexType } from "@/features/codex/typeApi";
import { useWorkspaceStore } from "@/features/workspace/store";
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

export interface CreateProjectFormData {
  title: string;
  genre: string;
  language: string;
  timelapseEnabled: boolean;
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

const GENRE_OPTIONS = ["", ...GENRE_VALUES];

/**
 * 新規プロジェクトの既定「執筆言語」を UI 言語から導く。UI が英語なら英語を、
 * それ以外は前方一致する対応言語（無ければ日本語）を既定にする。UI が英語なのに
 * 執筆言語が常に日本語だと、英語ユーザーが既定のまま作成すると JP 用埋め込みモデル
 * (ruri) が選ばれ、後で英語へ切替時に別モデル (bge) を無駄に DL することになる。
 * ※ 既存プロジェクトの language や DB フォールバック('ja') は変えない（変更すると
 *   full_model_id が変わり scene_chunks が全 stale 化＝フル再indexを誘発するため）。
 */
function defaultWritingLanguage(uiLanguage: string): string {
  return (
    LANGUAGE_OPTIONS.find((o) => uiLanguage.startsWith(o.value))?.value ?? "ja"
  );
}

/** 購読せず現在の UI 言語を読む（フォーム初期値・open リセットの種として使う）。 */
function currentUiLanguage(): string {
  return useWorkspaceStore.getState().globalSettings?.uiLanguage ?? "ja";
}

export function CreateProjectDialog({
  open,
  onClose,
  projects,
  defaultSourceProjectId,
  onCreate,
}: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [language, setLanguage] = useState(() =>
    defaultWritingLanguage(currentUiLanguage()),
  );
  const [timelapseEnabled, setTimelapseEnabled] = useState(true);
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
      setLanguage(defaultWritingLanguage(currentUiLanguage()));
      setTimelapseEnabled(true);
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
        timelapseEnabled,
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
      className={cn(
        "border border-border bg-background shadow-lg",
        phoneWorkspace
          ? "flex h-[var(--visual-viewport-height,100dvh)] w-screen min-h-0 min-w-0 max-h-none max-w-none flex-col overflow-hidden rounded-none border-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : "w-full max-w-md rounded-lg p-6",
      )}
      testId="create-project-dialog"
    >
      <h3
        className={cn(
          "text-sm font-semibold text-foreground",
          phoneWorkspace ? "shrink-0 border-b border-border px-4 py-4" : "mb-4",
        )}
      >
        {t("project.create.heading")}
      </h3>

      <div
        className={cn(phoneWorkspace && "flex min-h-0 flex-1 flex-col")}
        onKeyDown={handleKeyDown}
      >
        <div
          data-testid="create-project-scroll-region"
          className={cn(
            "space-y-3",
            phoneWorkspace &&
              "min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 py-4",
          )}
        >
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
              className={cn(
                "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                phoneWorkspace && "min-h-11",
              )}
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
              className={cn(
                "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                phoneWorkspace && "min-h-11",
              )}
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
              className={cn(
                "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                phoneWorkspace && "min-h-11",
              )}
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <label
            className={cn(
              "flex cursor-pointer items-start gap-2 text-xs text-muted-foreground",
              phoneWorkspace && "min-h-11",
            )}
          >
            <input
              type="checkbox"
              data-testid="project-timelapse-checkbox"
              checked={timelapseEnabled}
              onChange={(e) => setTimelapseEnabled(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="text-foreground">
                {t("project.create.timelapseLabel")}
              </span>
              <br />
              {t("project.create.timelapseHint")}
            </span>
          </label>

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
                className={cn(
                  "mb-3 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring",
                  phoneWorkspace && "min-h-11",
                )}
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
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-accent/50",
                        phoneWorkspace && "min-h-11",
                      )}
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
        </div>

        <div
          data-testid="create-project-actions"
          className={cn(
            "flex justify-end gap-2",
            phoneWorkspace
              ? "shrink-0 border-t border-border px-4 py-3"
              : "mt-3 pt-2",
          )}
        >
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              phoneWorkspace && "min-h-11",
            )}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            data-testid="project-create-submit"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className={cn(
              "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50",
              phoneWorkspace && "min-h-11",
            )}
          >
            {isSaving ? t("common.loading") : t("common.create")}
          </button>
        </div>
      </div>
    </AnimatedOverlay>
  );
}
