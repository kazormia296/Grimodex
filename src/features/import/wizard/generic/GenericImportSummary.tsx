import { useTranslation } from "react-i18next";
import type { ImportSourcePackageDraft } from "../../core/importSourcePackage";
import type { GenericImportAssemblyPlan } from "../../adapters/generic/assemblyPlan";

interface Props {
  readonly draft: ImportSourcePackageDraft | null;
  readonly assemblyPlan: GenericImportAssemblyPlan | null;
}

export function GenericImportSummary({ draft, assemblyPlan }: Props) {
  const { t } = useTranslation();

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="generic-import-summary"
    >
      <p className="text-sm text-muted-foreground">
        {t("import.generic.summaryHint", "Generic インポートの組み立て概要（プレビュー）。")}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("import.scenes", "シーン")}</dt>
        <dd>{draft?.nodes.length ?? assemblyPlan?.scenes.length ?? 0}</dd>
        <dt className="text-muted-foreground">{t("import.codexEntries", "Codexエントリ")}</dt>
        <dd>{draft?.structure.codexEntries.length ?? 0}</dd>
        <dt className="text-muted-foreground">{t("import.snippets", "スニペット")}</dt>
        <dd>{draft?.structure.snippets.length ?? 0}</dd>
        <dt className="text-muted-foreground">
          {t("import.generic.skipped", "スキップ")}
        </dt>
        <dd>{assemblyPlan?.skippedResourceKeys.length ?? 0}</dd>
      </dl>
    </section>
  );
}
