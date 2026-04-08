import { AliasesField } from "./AliasesField";

interface ExcludedAliasesFieldProps {
  excludedAliases: string[];
  onChange: (excludedAliases: string[]) => void;
}

export function ExcludedAliasesField({
  excludedAliases,
  onChange,
}: ExcludedAliasesFieldProps) {
  return (
    <AliasesField
      label="Excluded"
      aliases={excludedAliases}
      onChange={onChange}
      fieldId="excluded-aliases"
    />
  );
}
