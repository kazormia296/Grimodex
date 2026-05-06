import { useTranslation } from "react-i18next";
import { AliasesField } from "./AliasesField";

interface ExcludedAliasesFieldProps {
  excludedAliases: string[];
  onChange: (excludedAliases: string[]) => void;
}

export function ExcludedAliasesField({
  excludedAliases,
  onChange,
}: ExcludedAliasesFieldProps) {
  const { t } = useTranslation();
  return (
    <AliasesField
      label={t("codex.tracking.excludedLabel")}
      aliases={excludedAliases}
      onChange={onChange}
      fieldId="excluded-aliases"
    />
  );
}
