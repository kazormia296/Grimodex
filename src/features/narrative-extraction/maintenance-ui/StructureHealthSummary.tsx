import { useTranslation } from "react-i18next";
import {
  summarizeStructureHealth,
  type StructureHealthCount,
  type StructureHealthSummaryModel,
} from "./structureHealthModel";

interface Props {
  readonly model: StructureHealthSummaryModel;
}

export function StructureHealthSummary({ model }: Props) {
  const { t } = useTranslation();
  const rows: readonly StructureHealthCount[] = summarizeStructureHealth(model);

  return (
    <ul className="space-y-1 text-sm">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex items-center justify-between gap-4 border-b border-border/40 py-1"
        >
          <span className="text-muted-foreground">
            {String(t(row.labelKey, row.key))}
          </span>
          <span className="font-medium tabular-nums">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}
