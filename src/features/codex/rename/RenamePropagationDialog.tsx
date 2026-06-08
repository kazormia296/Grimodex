import { useEffect, useMemo, useState } from "react";
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

const KIND_LABEL: Record<RenameSourceKind, string> = {
  "scene-body": "本文",
  "node-title": "タイトル",
  "node-synopsis": "あらすじ",
  "codex-summary": "概要",
  "codex-content": "Codex 本文",
  "codex-notes": "メモ",
  "codex-detail": "詳細フィールド",
  "codex-relation-label": "関係ラベル",
};

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
    const map = new Map<string, Group>();
    for (const o of occurrences) {
      const s = o.source;
      const gkey = `${s.kind}:${s.refId}:${s.detailDefinitionId ?? ""}`;
      let g = map.get(gkey);
      if (!g) {
        g = {
          key: gkey,
          label: s.refLabel,
          kindLabel: KIND_LABEL[s.kind],
          items: [],
        };
        map.set(gkey, g);
      }
      g.items.push(o);
    }
    return [...map.values()];
  }, [occurrences]);

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
            「{pending?.oldName}」→「{pending?.newName}」を本文へ反映
          </DialogTitle>
          <DialogDescription>
            旧名が地の文や説明文に {occurrences.length} 件見つかりました。新名へ
            書き換える箇所を選んでください（@メンションは自動追従するため対象外）。
          </DialogDescription>
        </DialogHeader>

        {ambiguous && (
          <div className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            同名または別名が一致する別の Codex
            項目が存在します。どの項目を指すか
            自動判別できないため、既定ではすべてオフにしています。内容を確認のうえ
            個別に選択してください。
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <button className="hover:underline" onClick={() => setAll(true)}>
            すべて選択
          </button>
          <span>/</span>
          <button className="hover:underline" onClick={() => setAll(false)}>
            すべて解除
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
                          （ルビは対象外）
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
            {selected.length} / {selectableCount} 件を選択中
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={close} disabled={isApplying}>
              キャンセル
            </Button>
            <Button
              onClick={handleApply}
              disabled={isApplying || selected.length === 0}
            >
              {isApplying ? "反映中…" : `${selected.length} 件を反映`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
