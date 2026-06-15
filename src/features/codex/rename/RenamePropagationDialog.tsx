import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useRenamePropagationStore } from "./renamePropagationStore";
import { applyRenamePropagation } from "./renameEngine";
import type { RenameOccurrence, RenameSourceKind } from "./detectOccurrences";

const kindLabels = (): Record<RenameSourceKind, string> => ({
  "scene-body": i18next.t("codex.rename.kindSceneBody"),
  "node-title": i18next.t("codex.rename.kindNodeTitle"),
  "node-synopsis": i18next.t("codex.rename.kindNodeSynopsis"),
  "codex-summary": i18next.t("codex.rename.kindCodexSummary"),
  "codex-content": i18next.t("codex.rename.kindCodexContent"),
  "codex-notes": i18next.t("codex.rename.kindCodexNotes"),
  "codex-detail": i18next.t("codex.rename.kindCodexDetail"),
  "codex-relation-label": i18next.t("codex.rename.kindCodexRelationLabel"),
});

function occKey(o: RenameOccurrence): string {
  const s = o.source;
  return `${s.kind}:${s.refId}:${s.detailDefinitionId ?? ""}:${o.from}-${o.to}`;
}

interface Group {
  key: string;
  label: string;
  kindLabel: string;
  items: RenameOccurrence[];
}

/**
 * Modal preview for Codex rename propagation (Item C). Lists every plain-text
 * occurrence of the old name; the user confirms which to rewrite to the new
 * name. Ambiguous renames (another entry shares the name) default every row
 * OFF and show a warning; ruby occurrences are shown read-only (not rewritable).
 */
export function RenamePropagationDialog() {
  const { t, i18n } = useTranslation();
  const pending = useRenamePropagationStore((s) => s.pending);
  const isApplying = useRenamePropagationStore((s) => s.isApplying);
  const setApplying = useRenamePropagationStore((s) => s.setApplying);
  const close = useRenamePropagationStore((s) => s.close);

  const occurrences = useMemo(
    () => pending?.result.occurrences ?? [],
    [pending],
  );
  const ambiguous = pending?.result.ambiguous ?? false;

  // Default selection: ambiguous → none; otherwise every non-ruby row.
  // Re-initialised whenever a new rename session opens (idiomatic effect, not
  // a render-phase setState which can wedge re-renders across sessions).
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!pending) return;
    const init: Record<string, boolean> = {};
    for (const o of pending.result.occurrences) {
      init[occKey(o)] = !pending.result.ambiguous && !o.ruby;
    }
    setChecked(init);
  }, [pending]);

  const groups = useMemo<Group[]>(() => {
    const labels = kindLabels();
    const map = new Map<string, Group>();
    for (const o of occurrences) {
      const s = o.source;
      const gkey = `${s.kind}:${s.refId}:${s.detailDefinitionId ?? ""}`;
      let g = map.get(gkey);
      if (!g) {
        g = {
          key: gkey,
          label: s.refLabel,
          kindLabel: labels[s.kind],
          items: [],
        };
        map.set(gkey, g);
      }
      g.items.push(o);
    }
    return [...map.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occurrences, i18n.language]);

  const selected = occurrences.filter((o) => checked[occKey(o)] && !o.ruby);
  const selectableCount = occurrences.filter((o) => !o.ruby).length;

  const setAll = (value: boolean) => {
    const next: Record<string, boolean> = {};
    for (const o of occurrences) next[occKey(o)] = value && !o.ruby;
    setChecked(next);
  };

  const handleApply = async () => {
    if (!pending || selected.length === 0) return;
    setApplying(true);
    try {
      await applyRenamePropagation({
        projectId: getCurrentProjectId(),
        entryId: pending.entryId,
        oldName: pending.oldName,
        newName: pending.newName,
        selected,
      });
      close();
    } catch (e) {
      console.error("[codexRename] apply failed", e);
      setApplying(false);
    }
  };

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t("codex.rename.dialogTitle", {
              oldName: pending?.oldName,
              newName: pending?.newName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("codex.rename.dialogDesc", { count: occurrences.length })}
          </DialogDescription>
        </DialogHeader>

        {ambiguous && (
          <div className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t("codex.rename.ambiguousWarning")}
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <button className="hover:underline" onClick={() => setAll(true)}>
            {t("codex.rename.selectAll")}
          </button>
          <span>/</span>
          <button className="hover:underline" onClick={() => setAll(false)}>
            {t("codex.rename.deselectAll")}
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={g.key} className="space-y-1">
              <div className="sticky top-0 z-10 bg-popover py-1 text-xs font-medium text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5">
                  {g.kindLabel}
                </span>{" "}
                {g.label}
              </div>
              {g.items.map((o) => {
                const key = occKey(o);
                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-accent/40 ${
                      o.ruby ? "opacity-50" : ""
                    }`}
                  >
                    <Checkbox
                      checked={!!checked[key]}
                      disabled={o.ruby}
                      onCheckedChange={(v) =>
                        setChecked((prev) => ({ ...prev, [key]: !!v }))
                      }
                      className="mt-0.5"
                    />
                    <span className="min-w-0 break-words">
                      <span className="text-muted-foreground">{o.before}</span>
                      <span className="rounded bg-primary/15 px-0.5 font-medium text-primary">
                        {o.hit}
                      </span>
                      <span className="text-muted-foreground">{o.after}</span>
                      {o.ruby && (
                        <span className="ml-1 text-[10px] text-amber-600">
                          {t("codex.rename.rubyExcluded")}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>

        <DialogFooter className="shrink-0 items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {t("codex.rename.selectedCount", {
              selected: selected.length,
              total: selectableCount,
            })}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close} disabled={isApplying}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleApply}
              disabled={isApplying || selected.length === 0}
            >
              {isApplying
                ? t("codex.rename.applying")
                : t("codex.rename.applyButton", { count: selected.length })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
