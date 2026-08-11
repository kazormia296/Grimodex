import type { ImportTargetSpec } from "../core/importTargetSpec";

interface Props {
  readonly targetKind: "new-project" | "existing-project";
  readonly title: string;
  readonly onTargetKindChange: (
    kind: "new-project" | "existing-project",
  ) => void;
  readonly onTitleChange: (title: string) => void;
}

export function ImportTargetStep({
  targetKind,
  title,
  onTargetKindChange,
  onTitleChange,
}: Props) {
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="import-wizard-target-step"
    >
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="import-wizard-target-new"
          onClick={() => onTargetKindChange("new-project")}
          className={`rounded px-3 py-1.5 text-xs ${
            targetKind === "new-project"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          }`}
        >
          新規プロジェクト
        </button>
        <button
          type="button"
          data-testid="import-wizard-target-existing"
          onClick={() => onTargetKindChange("existing-project")}
          className={`rounded px-3 py-1.5 text-xs ${
            targetKind === "existing-project"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
          }`}
        >
          既存プロジェクト
        </button>
      </div>
      {targetKind === "new-project" && (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">タイトル</span>
          <input
            type="text"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1"
          />
        </label>
      )}
      {targetKind === "existing-project" && (
        <p className="text-xs text-muted-foreground">
          既存プロジェクトへのマージはプレビューのみ（未接続）。
        </p>
      )}
    </section>
  );
}

export function buildTargetSpecFromWizard(input: {
  readonly targetKind: "new-project" | "existing-project";
  readonly title: string;
  readonly projectId?: string;
}): ImportTargetSpec {
  if (input.targetKind === "existing-project" && input.projectId) {
    return { kind: "existing-project", projectId: input.projectId };
  }
  return { kind: "new-project", title: input.title.trim() || "Imported" };
}
