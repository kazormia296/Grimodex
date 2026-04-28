import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, X } from "lucide-react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { useForeshadowStore } from "./foreshadowStore";
import { useForeshadowNavStore } from "./foreshadowNavStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  addCodexLink,
  removeCodexLink,
  listCodexEntriesByForeshadow,
} from "./api";
import { listCodexEntries } from "@/features/codex/api";
import type { CodexEntry } from "@/features/codex/api";
import type { ForeshadowWithLabel } from "./types";

interface EditForeshadowDialogProps {
  open: boolean;
  item: ForeshadowWithLabel | null;
  onClose: () => void;
}

export function EditForeshadowDialog({
  open,
  item,
  onClose,
}: EditForeshadowDialogProps) {
  const { t } = useTranslation();
  const { update } = useForeshadowStore();

  const [title, setTitle] = useState("");
  const [intent, setIntent] = useState("");
  const [notes, setNotes] = useState("");
  const [payoffConfirmed, setPayoffConfirmed] = useState(false);
  const [abandoned, setAbandoned] = useState(false);
  const [showUnsetConfirm, setShowUnsetConfirm] = useState(false);
  const [willUnsetAnchor, setWillUnsetAnchor] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Codex link state
  const [initialLinkedIds, setInitialLinkedIds] = useState<Set<string>>(
    new Set(),
  );
  const [linkedEntries, setLinkedEntries] = useState<Map<string, CodexEntry>>(
    new Map(),
  );
  const [linksToAdd, setLinksToAdd] = useState<Set<string>>(new Set());
  const [linksToRemove, setLinksToRemove] = useState<Set<string>>(new Set());
  const [allCodexEntries, setAllCodexEntries] = useState<CodexEntry[]>([]);
  const [codexSearch, setCodexSearch] = useState("");
  const [showCodexSearch, setShowCodexSearch] = useState(false);

  useEffect(() => {
    if (open && item) {
      setTitle(item.title);
      setIntent(item.intent ?? "");
      setNotes(item.notes ?? "");
      setPayoffConfirmed(item.payoffConfirmed);
      setAbandoned(item.abandoned);
      setShowUnsetConfirm(false);
      setWillUnsetAnchor(false);
      setIsSaving(false);
      setLinksToAdd(new Set());
      setLinksToRemove(new Set());
      setCodexSearch("");
      setShowCodexSearch(false);

      void listCodexEntriesByForeshadow(item.id).then((entries) => {
        const m = new Map(entries.map((e) => [e.id, e]));
        setInitialLinkedIds(new Set(m.keys()));
        setLinkedEntries(m);
      });

      void listCodexEntries().then(setAllCodexEntries);
    }
    // item.id をキーにしてスナップショットを取る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  const nodes = useTreeStore((s) => s.nodes);

  const payoffSceneNode = item?.payoffSceneId
    ? nodes.find((n) => n.id === item.payoffSceneId)
    : undefined;
  const payoffChapterNode = payoffSceneNode?.parentId
    ? nodes.find((n) => n.id === payoffSceneNode.parentId)
    : undefined;

  const payoffLabel = payoffSceneNode
    ? payoffChapterNode
      ? `${payoffChapterNode.title} / ${payoffSceneNode.title}`
      : payoffSceneNode.title
    : null;

  const hasPayoffAnchor =
    item?.payoffSceneId != null &&
    item.payoffFromPos != null &&
    item.payoffToPos != null;

  const canSave = title.trim().length > 0 && !isSaving;

  const handleSave = async () => {
    if (!item || !canSave) return;
    setIsSaving(true);
    try {
      type Patch = Parameters<typeof update>[1];
      const patch: Patch = {};

      if (title.trim() !== item.title) patch.title = title.trim();
      if ((intent.trim() || null) !== item.intent)
        patch.intent = intent.trim() || null;
      if ((notes.trim() || null) !== item.notes)
        patch.notes = notes.trim() || null;
      if (payoffConfirmed !== item.payoffConfirmed)
        patch.payoffConfirmed = payoffConfirmed;
      if (abandoned !== item.abandoned) patch.abandoned = abandoned;

      if (willUnsetAnchor) {
        patch.payoffSceneId = null;
        patch.payoffFromPos = null;
        patch.payoffToPos = null;
        patch.payoffConfirmed = false;
      }

      const hasPatch = Object.keys(patch).length > 0;
      if (hasPatch) await update(item.id, patch, item.projectId);
      for (const id of linksToAdd) await addCodexLink(item.id, id);
      for (const id of linksToRemove) await removeCodexLink(item.id, id);
      onClose();
    } finally {
      setIsSaving(false);
    }
  };

  // 現在表示すべき Codex セット: (initial ∪ toAdd) − toRemove
  const visibleLinkedIds = new Set([...initialLinkedIds, ...linksToAdd]);
  for (const id of linksToRemove) visibleLinkedIds.delete(id);

  const handleAddCodexLink = (entry: CodexEntry) => {
    if (visibleLinkedIds.has(entry.id)) return;
    if (initialLinkedIds.has(entry.id)) {
      setLinksToRemove((prev) => {
        const s = new Set(prev);
        s.delete(entry.id);
        return s;
      });
    } else {
      setLinksToAdd((prev) => new Set([...prev, entry.id]));
    }
    setLinkedEntries((prev) => new Map([...prev, [entry.id, entry]]));
    setCodexSearch("");
    setShowCodexSearch(false);
  };

  const handleRemoveCodexLink = (id: string) => {
    if (initialLinkedIds.has(id)) {
      setLinksToRemove((prev) => new Set([...prev, id]));
    } else {
      setLinksToAdd((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
    }
  };

  const filteredCodexSuggestions = allCodexEntries.filter((e) => {
    if (visibleLinkedIds.has(e.id)) return false;
    const q = codexSearch.toLowerCase();
    if (!q) return true;
    if (e.name.toLowerCase().includes(q)) return true;
    try {
      const aliases = e.aliases ? (JSON.parse(e.aliases) as string[]) : [];
      return aliases.some((a) => a.toLowerCase().includes(q));
    } catch {
      return false;
    }
  });

  const handleJumpToPayoff = () => {
    if (
      !item?.payoffSceneId ||
      item.payoffFromPos == null ||
      item.payoffToPos == null
    )
      return;
    useForeshadowNavStore.getState().requestJump({
      sceneId: item.payoffSceneId,
      fromPos: item.payoffFromPos,
      toPos: item.payoffToPos,
    });
    useTreeStore.getState().setActiveScene(item.payoffSceneId);
    useLayoutStore.getState().showPanel("editor");
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSave();
    if (e.key === "Escape") onClose();
  };

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-lg"
      testId="edit-foreshadow-dialog"
    >
      <h3 className="mb-4 text-sm font-semibold text-foreground">
        {t("foreshadow.edit.heading")}
      </h3>

      <div className="space-y-3" onKeyDown={handleKeyDown}>
        {/* タイトル */}
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("foreshadow.create.titleLabel")}
          </label>
          <input
            data-testid="edit-foreshadow-title-input"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* 意図 */}
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("foreshadow.create.intentLabel")}
          </label>
          <textarea
            data-testid="edit-foreshadow-intent-input"
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* メモ */}
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            {t("foreshadow.edit.notesLabel")}
          </label>
          <textarea
            data-testid="edit-foreshadow-notes-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("foreshadow.edit.notesPlaceholder")}
            rows={3}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* ライフサイクル */}
        <div className="border-t border-border/50 pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("foreshadow.edit.lifecycleSection")}
          </p>
          <div className="space-y-2">
            <label className="flex items-center gap-2">
              <input
                data-testid="edit-foreshadow-payoff-confirmed"
                type="checkbox"
                checked={payoffConfirmed}
                disabled={!hasPayoffAnchor || willUnsetAnchor}
                onChange={(e) => setPayoffConfirmed(e.target.checked)}
                className="rounded border-input"
              />
              <span
                className={`text-xs ${!hasPayoffAnchor || willUnsetAnchor ? "text-muted-foreground/50" : "text-foreground"}`}
              >
                {t("foreshadow.edit.confirmPayoff")}
              </span>
              {(!hasPayoffAnchor || willUnsetAnchor) && (
                <span className="text-[10px] text-muted-foreground">
                  ({t("foreshadow.edit.confirmDisabled")})
                </span>
              )}
            </label>

            <label className="flex items-center gap-2">
              <input
                data-testid="edit-foreshadow-abandoned"
                type="checkbox"
                checked={abandoned}
                onChange={(e) => setAbandoned(e.target.checked)}
                className="rounded border-input"
              />
              <span className="text-xs text-foreground">
                {t("foreshadow.edit.abandonedLabel")}
              </span>
            </label>
          </div>
        </div>

        {/* Payoff anchor */}
        <div className="border-t border-border/50 pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("foreshadow.edit.payoffAnchorSection")}
          </p>

          {willUnsetAnchor ? (
            <span
              data-testid="edit-foreshadow-unset-pending"
              className="text-xs text-destructive/70"
            >
              {t("foreshadow.edit.payoffAnchorNone")}
            </span>
          ) : showUnsetConfirm ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
              <p className="mb-2 text-[11px] text-destructive">
                {t("foreshadow.edit.unsetAnchorConfirm")}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="edit-foreshadow-unset-confirm"
                  onClick={() => {
                    setWillUnsetAnchor(true);
                    setShowUnsetConfirm(false);
                    setPayoffConfirmed(false);
                  }}
                  className="rounded px-2 py-1 text-[11px] text-destructive hover:bg-destructive/10"
                >
                  {t("common.confirm")}
                </button>
                <button
                  type="button"
                  data-testid="edit-foreshadow-unset-cancel"
                  onClick={() => setShowUnsetConfirm(false)}
                  className="rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : hasPayoffAnchor ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-foreground">
                  {payoffLabel ?? item?.payoffSceneId}
                </span>
                <button
                  type="button"
                  onClick={handleJumpToPayoff}
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t("foreshadow.panel.jumpPayoff")}
                >
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
              <button
                type="button"
                data-testid="edit-foreshadow-unset-anchor"
                onClick={() => setShowUnsetConfirm(true)}
                className="text-[11px] text-destructive hover:underline"
              >
                {t("foreshadow.edit.unsetAnchor")}
              </button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("foreshadow.edit.payoffAnchorNone")}
            </span>
          )}
        </div>

        {/* 関連 Codex */}
        <div className="border-t border-border/50 pt-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {t("foreshadow.edit.linkedCodexSection", "関連 Codex")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {[...visibleLinkedIds].map((id) => {
              const entry = linkedEntries.get(id);
              if (!entry) return null;
              return (
                <span
                  key={id}
                  className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
                >
                  {entry.name}
                  <button
                    type="button"
                    data-testid={`edit-foreshadow-unlink-codex-${id}`}
                    onClick={() => handleRemoveCodexLink(id)}
                    className="rounded-full p-0.5 hover:bg-accent"
                    aria-label={t("common.remove", "削除")}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              );
            })}
            {!showCodexSearch && (
              <button
                type="button"
                data-testid="edit-foreshadow-add-codex"
                onClick={() => setShowCodexSearch(true)}
                className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
              >
                {t("foreshadow.edit.addCodex", "+ Codex を追加")}
              </button>
            )}
          </div>

          {showCodexSearch && (
            <div className="mt-1.5">
              <input
                data-testid="edit-foreshadow-codex-search"
                type="text"
                autoFocus
                value={codexSearch}
                onChange={(e) => setCodexSearch(e.target.value)}
                placeholder={t(
                  "foreshadow.edit.codexSearchPlaceholder",
                  "Codex を検索…",
                )}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setShowCodexSearch(false);
                    setCodexSearch("");
                  }
                }}
              />
              {filteredCodexSuggestions.length > 0 && (
                <ul className="mt-1 max-h-36 overflow-y-auto rounded-md border border-border bg-background shadow-sm">
                  {filteredCodexSuggestions.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        data-testid={`edit-foreshadow-codex-option-${entry.id}`}
                        onClick={() => handleAddCodexLink(entry)}
                        className="w-full px-2 py-1 text-left text-xs hover:bg-accent"
                      >
                        {entry.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          data-testid="edit-foreshadow-cancel"
          onClick={onClose}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="edit-foreshadow-save"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
        >
          {t("common.save")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}
