import { useTranslation } from "react-i18next";
import type {
  GenericImportResourceRole,
  ImportResourceDisposition,
} from "../../adapters/generic/resourceRole";

interface Props {
  readonly role: GenericImportResourceRole;
  readonly disposition: ImportResourceDisposition;
  readonly candidates: readonly GenericImportResourceRole[];
  readonly onRoleChange: (role: GenericImportResourceRole) => void;
}

const ROLE_OPTIONS: readonly GenericImportResourceRole[] = [
  "manuscript",
  "outline",
  "character-reference",
  "world-reference",
  "glossary",
  "timeline-reference",
  "plot-reference",
  "snippet-library",
  "chat-log",
  "project-metadata",
  "research-reference",
  "attachment",
  "ignore",
  "unknown",
];

export function GenericRolePicker({
  role,
  disposition,
  candidates,
  onRoleChange,
}: Props) {
  const { t } = useTranslation();

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="generic-import-role-picker"
    >
      <p className="text-sm text-muted-foreground">
        {t("import.generic.rolePickerHint", "リソースの semantic role を確認します（プレビュー）。")}
      </p>
      <div className="flex flex-wrap gap-1">
        {ROLE_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`generic-role-${option}`}
            onClick={() => onRoleChange(option)}
            className={`rounded px-2 py-1 text-xs ${
              role === option
                ? "bg-primary text-primary-foreground"
                : candidates.includes(option)
                  ? "bg-muted text-foreground"
                  : "bg-muted/50 text-muted-foreground"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("import.generic.disposition", "配置")}: {disposition}
      </p>
    </section>
  );
}
