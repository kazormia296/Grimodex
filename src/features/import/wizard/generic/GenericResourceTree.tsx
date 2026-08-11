import { useTranslation } from "react-i18next";
import type { ResourceRoleResolution } from "../../adapters/generic/roleClassifier";

interface Props {
  readonly resources: readonly ResourceRoleResolution[];
  readonly selectedResourceKey: string | null;
  readonly onSelectResource: (resourceKey: string) => void;
}

export function GenericResourceTree({
  resources,
  selectedResourceKey,
  onSelectResource,
}: Props) {
  const { t } = useTranslation();

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="generic-import-resource-tree"
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "import.generic.resourceTreeHint",
          "取り込み対象ファイルと推定ロール（プレビュー）。",
        )}
      </p>
      <ul className="flex flex-col gap-1 text-xs">
        {resources.map((resource) => (
          <li key={resource.resourceKey}>
            <button
              type="button"
              data-testid={`generic-resource-${resource.resourceKey}`}
              onClick={() => onSelectResource(resource.resourceKey)}
              className={`w-full rounded px-2 py-1 text-left ${
                selectedResourceKey === resource.resourceKey
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent"
              }`}
            >
              <span className="font-medium">{resource.relativePath}</span>
              <span className="ml-2 opacity-80">→ {resource.role}</span>
            </button>
          </li>
        ))}
        {resources.length === 0 && (
          <li className="text-muted-foreground">
            {t("import.generic.noResources", "リソースがありません")}
          </li>
        )}
      </ul>
    </section>
  );
}
