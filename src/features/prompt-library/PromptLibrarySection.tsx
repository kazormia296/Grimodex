import { useEffect, useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingSection } from "@/features/settings/components/SettingSection";
import { usePromptLibraryStore } from "./promptLibraryStore";
import { PromptTemplateEditorDialog } from "./PromptTemplateEditorDialog";
import type { PromptTemplate } from "./api";

/**
 * 設定 → AI タブのプロジェクト帯に置くプロンプトライブラリ管理 UI。
 * 一覧 + 追加 / 編集 / 削除。AiCategory には import + 1 行設置のみ。
 */
export function PromptLibrarySection() {
  const { t } = useTranslation();
  const templates = usePromptLibraryStore((s) => s.templates);
  const ensureLoaded = usePromptLibraryStore((s) => s.ensureLoaded);
  const create = usePromptLibraryStore((s) => s.create);
  const update = usePromptLibraryStore((s) => s.update);
  const remove = usePromptLibraryStore((s) => s.remove);

  // null = 閉じている / "new" = 新規 / それ以外 = 編集中の id
  const [editing, setEditing] = useState<PromptTemplate | "new" | null>(null);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  const handleSubmit = async (title: string, content: string) => {
    if (editing === "new") {
      await create(title, content);
    } else if (editing) {
      await update(editing.id, { title, content });
    }
    setEditing(null);
  };

  return (
    <SettingSection title={t("promptLibrary.section.title")}>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("promptLibrary.section.intro")}
      </p>

      {templates.length === 0 ? (
        <p className="mb-3 rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("promptLibrary.section.empty")}
        </p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {tpl.title}
                </div>
                <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                  {tpl.content}
                </div>
                {tpl.usageCount > 0 && (
                  <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {t("promptLibrary.section.usageCount", {
                      count: tpl.usageCount,
                    })}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(tpl)}
                  aria-label={t("promptLibrary.section.editAria", {
                    title: tpl.title,
                  })}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(tpl.id)}
                  aria-label={t("promptLibrary.section.deleteAria", {
                    title: tpl.title,
                  })}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setEditing("new")}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t("promptLibrary.section.add")}
      </button>

      {editing && (
        <PromptTemplateEditorDialog
          heading={
            editing === "new"
              ? t("promptLibrary.editor.headingNew")
              : t("promptLibrary.editor.headingEdit")
          }
          initialTitle={editing === "new" ? "" : editing.title}
          initialContent={editing === "new" ? "" : editing.content}
          onSubmit={handleSubmit}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingSection>
  );
}
