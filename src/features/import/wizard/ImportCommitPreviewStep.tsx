import type { ImportSourcePackageDraft } from "../core/importSourcePackage";
import type { ImportTargetSpec } from "../core/importTargetSpec";

interface Props {
  readonly draft: ImportSourcePackageDraft | null;
  readonly target: ImportTargetSpec | null;
}

export function ImportCommitPreviewStep({ draft, target }: Props) {
  return (
    <section
      className="flex flex-col gap-2"
      data-testid="import-wizard-commit-preview-step"
    >
      <p className="text-xs text-muted-foreground">
        コミットはプレビューのみ — 実際の書き込みは行いません。
      </p>
      {target && (
        <p className="text-xs">
          ターゲット:{" "}
          {target.kind === "new-project"
            ? `新規「${target.title}」`
            : `既存 (${target.projectId})`}
        </p>
      )}
      {draft && (
        <p className="text-xs text-muted-foreground">
          {draft.documents.length} ドキュメント /{" "}
          {draft.structure.codexEntries.length} codex
        </p>
      )}
    </section>
  );
}
