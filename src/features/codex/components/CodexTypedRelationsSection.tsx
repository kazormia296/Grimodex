import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { CodexEntry } from "../api";
import { useCodexStore } from "../codexStore";
import {
  listCodexRelationsForEntry,
  deleteCodexRelation,
  createCodexRelation,
  findCodexRelationExact,
  type CodexRelationRow,
} from "../codexRelationApi";
import { slugifyRelationType } from "../relationExpansion";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";

interface CodexTypedRelationsSectionProps {
  entry: CodexEntry;
}

const PRESET_KEYS = [
  "friend",
  "family",
  "lover",
  "enemy",
  "mentor",
  "servant",
] as const;

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

  const [targetId, setTargetId] = useState("");
  const [direction, setDirection] = useState<"outgoing" | "incoming">(
    "outgoing",
  );
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    const rows = await listCodexRelationsForEntry(entry.id);
    setRelations(rows);
  }, [entry.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Same-project entries excluding self, as relation targets.
  const targetOptions = useMemo(
    () =>
      entries
        .filter((e) => e.projectId === entry.projectId && e.id !== entry.id)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entries, entry.projectId, entry.id],
  );

  const resolveName = (id: string) =>
    entries.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  const handleDelete = async (id: string) => {
    await deleteCodexRelation(id);
    toast.success(t("codex.relation.typedRemoved"));
    await reload();
  };

  const handleAdd = async () => {
    const trimmed = label.trim();
    if (!targetId) {
      toast.error(t("codex.relation.targetRequired"));
      return;
    }
    if (!trimmed) {
      toast.error(t("codex.relation.labelRequired"));
      return;
    }
    const relationType = slugifyRelationType(trimmed);
    const fromCodexId = direction === "outgoing" ? entry.id : targetId;
    const toCodexId = direction === "outgoing" ? targetId : entry.id;
    setSubmitting(true);
    try {
      const dup = await findCodexRelationExact(
        entry.projectId,
        fromCodexId,
        toCodexId,
        relationType,
      );
      if (dup) {
        toast.error(t("codex.relation.duplicate"));
        return;
      }
      await createCodexRelation({
        projectId: entry.projectId,
        fromCodexId,
        toCodexId,
        relationType,
        label: trimmed,
      });
      toast.success(t("codex.relation.created"));
      setLabel("");
      setTargetId("");
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div>
        <h3 className="text-xs font-semibold">
          {t("codex.relation.typedTitle")}
        </h3>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {t("codex.relation.typedDesc")}
        </p>
      </div>

      {relations.length > 0 && (
        <ul className="space-y-1">
          {relations.map((rel) => {
            const outgoing = rel.fromCodexId === entry.id;
            const otherId = outgoing ? rel.toCodexId : rel.fromCodexId;
            const arrow = outgoing ? "→" : "←";
            const relLabel = rel.label?.trim() || rel.relationType;
            return (
              <li
                key={rel.id}
                className="flex items-start gap-2 rounded border border-border/60 bg-muted/20 px-2 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{relLabel}</span>
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
      )}

      {/* Add relation form */}
      <form
        className="space-y-1.5 rounded border border-dashed border-border/70 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting) void handleAdd();
        }}
      >
        <SectionLabel>{t("codex.relation.addTitle")}</SectionLabel>

        <select
          aria-label={t("codex.relation.targetLabel")}
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
        >
          <option value="">{t("codex.relation.targetPlaceholder")}</option>
          {targetOptions.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}（{getTypeLabel(e.type)}）
            </option>
          ))}
        </select>

        <div className="flex gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => setDirection("outgoing")}
            className={`flex-1 rounded border px-1.5 py-1 ${
              direction === "outgoing"
                ? "border-[#534AB7] bg-[#534AB7] text-white"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {t("codex.relation.directionOutgoing")}
          </button>
          <button
            type="button"
            onClick={() => setDirection("incoming")}
            className={`flex-1 rounded border px-1.5 py-1 ${
              direction === "incoming"
                ? "border-[#534AB7] bg-[#534AB7] text-white"
                : "border-border bg-background text-muted-foreground"
            }`}
          >
            {t("codex.relation.directionIncoming")}
          </button>
        </div>

        <div className="flex flex-wrap gap-1">
          {PRESET_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setLabel(t(`codex.relation.presets.${key}`))}
              className="rounded border border-border bg-muted/30 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            >
              {t(`codex.relation.presets.${key}`)}
            </button>
          ))}
        </div>

        <div className="flex gap-1">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("codex.relation.labelPlaceholder")}
            className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
          />
          <button
            type="submit"
            disabled={submitting}
            className="shrink-0 rounded bg-[#534AB7] px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {t("codex.relation.add")}
          </button>
        </div>
      </form>
    </div>
  );
}
