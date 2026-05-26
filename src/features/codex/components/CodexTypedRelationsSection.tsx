import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { CodexEntry } from "../api";
import { useCodexStore } from "../codexStore";
import {
  listCodexRelationsForEntry,
  deleteCodexRelation,
  type CodexRelationRow,
} from "../codexRelationApi";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";

interface CodexTypedRelationsSectionProps {
  entry: CodexEntry;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  );
}

export function CodexTypedRelationsSection({
  entry,
}: CodexTypedRelationsSectionProps) {
  const { t } = useTranslation();
  const entries = useCodexStore((s) => s.entries);
  const [relations, setRelations] = useState<CodexRelationRow[]>([]);

  const reload = useCallback(async () => {
    const rows = await listCodexRelationsForEntry(entry.id);
    setRelations(rows);
  }, [entry.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const resolveName = (id: string) =>
    entries.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  const handleDelete = async (id: string) => {
    await deleteCodexRelation(id);
    toast.success(t("codex.relation.typedRemoved"));
    await reload();
  };

  if (relations.length === 0) return null;

  return (
    <div className="space-y-1 border-t border-border pt-3">
      <SectionLabel>{t("codex.relation.typedTitle")}</SectionLabel>
      <ul className="space-y-1">
        {relations.map((rel) => {
          const outgoing = rel.fromCodexId === entry.id;
          const otherId = outgoing ? rel.toCodexId : rel.fromCodexId;
          const arrow = outgoing ? "→" : "←";
          const label = rel.label?.trim() || rel.relationType;
          return (
            <li
              key={rel.id}
              className="flex items-start gap-2 rounded border border-border/60 bg-muted/20 px-2 py-1.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground">
                  {" "}
                  {arrow} {resolveName(otherId)}
                </span>
                <span className="ml-1 text-[10px] text-muted-foreground">
                  (
                  {getTypeLabel(
                    entries.find((e) => e.id === otherId)?.type ?? "lore",
                  )}
                  )
                </span>
              </div>
              <button
                type="button"
                aria-label={t("codex.relation.typedRemove")}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                onClick={() => void handleDelete(rel.id)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
