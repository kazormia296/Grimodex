import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  createProjectSnapshot,
  listProjectSnapshots,
  restoreProjectSnapshot,
  deleteProjectSnapshot,
  type ProjectSnapshotMeta,
} from "./projectSnapshotApi";

interface ProjectSnapshotModalProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ProjectSnapshotModal({
  open,
  onClose,
}: ProjectSnapshotModalProps) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<ProjectSnapshotMeta[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Confirm states
  const [confirmRestoreId, setConfirmRestoreId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setShowCreate(false);
      setCreateName("");
      setCreateDesc("");
      setConfirmRestoreId(null);
      setConfirmDeleteId(null);
      return;
    }
    loadSnapshots();
  }, [open]);

  async function loadSnapshots() {
    setIsLoading(true);
    try {
      const list = await listProjectSnapshots();
      setSnapshots(list);
    } catch {
      toast.error(t("snapshot.loadError"));
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCreate() {
    if (!createName.trim()) return;
    setIsCreating(true);
    try {
      const result = await createProjectSnapshot({
        name: createName.trim(),
        description: createDesc.trim() || undefined,
      });
      toast.success(
        t("snapshot.createSuccess", {
          name: createName.trim(),
          count: result.entryCount,
        }),
      );
      setShowCreate(false);
      setCreateName("");
      setCreateDesc("");
      await loadSnapshots();
    } catch {
      toast.error(t("snapshot.createError"));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleRestoreConfirm() {
    if (!confirmRestoreId) return;
    const snap = snapshots.find((s) => s.id === confirmRestoreId);
    if (!snap) return;
    setIsRestoring(true);
    try {
      const result = await restoreProjectSnapshot(snap.id, snap.name);
      toast.success(
        t("snapshot.restoreSuccess", {
          name: snap.name,
          count: result.restoredCount,
        }),
      );
      setConfirmRestoreId(null);
      setSelectedId(null);
      onClose();
      // Content is restored in DB; page reload ensures editors reflect changes
      window.location.reload();
    } catch {
      toast.error(t("snapshot.restoreError"));
    } finally {
      setIsRestoring(false);
    }
  }

  async function handleDeleteConfirm() {
    if (!confirmDeleteId) return;
    const snap = snapshots.find((s) => s.id === confirmDeleteId);
    setIsDeleting(true);
    try {
      await deleteProjectSnapshot(confirmDeleteId);
      toast.success(t("snapshot.deleteSuccess", { name: snap?.name ?? "" }));
      setConfirmDeleteId(null);
      if (selectedId === confirmDeleteId) setSelectedId(null);
      await loadSnapshots();
    } catch {
      toast.error(t("snapshot.deleteError"));
    } finally {
      setIsDeleting(false);
    }
  }

  if (!open) return null;

  // Confirm restore dialog
  if (confirmRestoreId) {
    const snap = snapshots.find((s) => s.id === confirmRestoreId);
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
        <div className="bg-background rounded-lg border border-border shadow-xl p-6 w-[440px] max-w-[95vw]">
          <h2 className="text-base font-semibold mb-3">
            {t("snapshot.restoreTitle")}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("snapshot.restoreDesc", { name: snap?.name })}
            <br />
            {t("snapshot.restoreDescSub")}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
              onClick={() => setConfirmRestoreId(null)}
              disabled={isRestoring}
            >
              {t("snapshot.cancel")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              onClick={handleRestoreConfirm}
              disabled={isRestoring}
            >
              {isRestoring
                ? t("snapshot.restoring")
                : t("snapshot.restoreConfirm")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Confirm delete dialog
  if (confirmDeleteId) {
    const snap = snapshots.find((s) => s.id === confirmDeleteId);
    return (
      <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
        <div className="bg-background rounded-lg border border-border shadow-xl p-6 w-[440px] max-w-[95vw]">
          <h2 className="text-base font-semibold mb-3">
            {t("snapshot.deleteTitle")}
          </h2>
          <p className="text-sm text-muted-foreground mb-6">
            {t("snapshot.deleteDesc", { name: snap?.name })}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
              onClick={() => setConfirmDeleteId(null)}
              disabled={isDeleting}
            >
              {t("snapshot.cancel")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-50"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              {isDeleting
                ? t("snapshot.deleting")
                : t("snapshot.deleteConfirm")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-background rounded-lg border border-border shadow-xl w-[580px] max-w-[95vw] flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold">{t("snapshot.title")}</h2>
          <button
            type="button"
            aria-label={t("snapshot.close")}
            className="text-muted-foreground hover:text-foreground transition-colors"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {/* Create form */}
        <div className="px-4 py-3 border-b border-border flex-shrink-0">
          {showCreate ? (
            <div className="space-y-2">
              <input
                type="text"
                placeholder={t("snapshot.namePlaceholder")}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setShowCreate(false);
                }}
              />
              <input
                type="text"
                placeholder={t("snapshot.descPlaceholder")}
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                className="w-full rounded border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
                  onClick={() => setShowCreate(false)}
                  disabled={isCreating}
                >
                  {t("snapshot.cancel")}
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  onClick={handleCreate}
                  disabled={isCreating || !createName.trim()}
                >
                  {isCreating ? t("snapshot.creating") : t("snapshot.create")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="w-full rounded border border-dashed border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/50 transition-colors"
              onClick={() => setShowCreate(true)}
            >
              {t("snapshot.newSnapshot")}
            </button>
          )}
        </div>

        {/* Snapshot list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("snapshot.loading")}
            </p>
          ) : snapshots.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("snapshot.empty")}
            </p>
          ) : (
            snapshots.map((snap) => (
              <button
                key={snap.id}
                type="button"
                onClick={() =>
                  setSelectedId(snap.id === selectedId ? null : snap.id)
                }
                className={[
                  "w-full text-left px-3 py-2 rounded text-sm transition-colors",
                  snap.id === selectedId
                    ? "bg-primary/20 text-primary"
                    : "hover:bg-muted text-foreground",
                ].join(" ")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium block truncate">
                      ★ {snap.name}
                    </span>
                    {snap.description && (
                      <span className="text-xs text-muted-foreground block truncate">
                        {snap.description}
                      </span>
                    )}
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <span className="block text-xs text-muted-foreground">
                      {formatTimestamp(snap.createdAt)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("snapshot.entityCount", { count: snap.entryCount })}
                    </span>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            type="button"
            className="px-3 py-1.5 text-sm rounded border border-destructive text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => selectedId && setConfirmDeleteId(selectedId)}
            disabled={!selectedId}
          >
            {t("snapshot.delete")}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded border border-border hover:bg-muted transition-colors"
              onClick={onClose}
            >
              {t("snapshot.close")}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => selectedId && setConfirmRestoreId(selectedId)}
              disabled={!selectedId}
            >
              {t("snapshot.restore")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
