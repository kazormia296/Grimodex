import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { loadSceneContents } from "@/features/tree/api";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import {
  isQuiescenceLeaseActive,
  subscribeQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { useLinearEditorStore } from "./linearEditorStore";
import { useEditorSessionStore } from "./editorSessionStore";

interface AccessibleLinearReaderDialogProps {
  scenes: readonly TreeNodeData[];
}

interface ReaderScene {
  id: string;
  title: string;
  text: string;
  source: "database" | "live";
}

/**
 * Static all-scenes projection for screen readers and browser find. Content is
 * fetched with one batch read; dirty mounted editors override their persisted
 * snapshot so opening the reader never hides the user's latest keystrokes.
 */
export function AccessibleLinearReaderDialog({
  scenes,
}: AccessibleLinearReaderDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [readerScenes, setReaderScenes] = useState<ReaderScene[]>([]);
  const loadGenerationRef = useRef(0);
  const lifecycleLocked = useSyncExternalStore(
    subscribeQuiescenceLease,
    isQuiescenceLeaseActive,
    () => false,
  );
  // Include every field copied into the projection. Project ids are part of
  // each tree row, so equal scene ids in two Projects remain distinct scopes.
  const scopeFingerprint = useMemo(
    () =>
      JSON.stringify(
        scenes.map(({ projectId, id, title }) => ({ projectId, id, title })),
      ),
    [scenes],
  );
  const scopeFingerprintRef = useRef(scopeFingerprint);
  scopeFingerprintRef.current = scopeFingerprint;
  const previousScopeFingerprintRef = useRef(scopeFingerprint);

  const loadReader = useCallback(async () => {
    if (isQuiescenceLeaseActive()) return;

    const generation = ++loadGenerationRef.current;
    const requestedScope = scopeFingerprint;
    const requestedScenes = scenes.map(({ id, title }) => ({ id, title }));
    setLoading(true);
    setError(false);
    try {
      const ids = requestedScenes.map((scene) => scene.id);
      const persisted = await loadSceneContents(ids);
      if (
        generation !== loadGenerationRef.current ||
        requestedScope !== scopeFingerprintRef.current ||
        isQuiescenceLeaseActive()
      ) {
        return;
      }
      const editors = useLinearEditorStore.getState().editorsById;
      const dirtyIds = useEditorSessionStore.getState().dirtyDocumentIds;
      setReaderScenes(
        requestedScenes.map((scene) => {
          const liveEditor = dirtyIds.has(scene.id)
            ? editors[scene.id]
            : undefined;
          return {
            id: scene.id,
            title: scene.title,
            text: liveEditor
              ? liveEditor.getText({ blockSeparator: "\n" })
              : prosemirrorToText(persisted.get(scene.id) ?? ""),
            source: liveEditor ? "live" : "database",
          };
        }),
      );
    } catch {
      if (
        generation === loadGenerationRef.current &&
        requestedScope === scopeFingerprintRef.current &&
        !isQuiescenceLeaseActive()
      ) {
        setReaderScenes([]);
        setError(true);
      }
    } finally {
      if (
        generation === loadGenerationRef.current &&
        requestedScope === scopeFingerprintRef.current &&
        !isQuiescenceLeaseActive()
      ) {
        setLoading(false);
      }
    }
  }, [scenes, scopeFingerprint]);

  useEffect(() => {
    if (previousScopeFingerprintRef.current === scopeFingerprint) return;
    previousScopeFingerprintRef.current = scopeFingerprint;
    loadGenerationRef.current += 1;
    setReaderScenes([]);
    setError(false);
    setLoading(false);
    if (open && !lifecycleLocked) void loadReader();
  }, [lifecycleLocked, loadReader, open, scopeFingerprint]);

  useEffect(() => {
    if (!lifecycleLocked) return;
    // DialogContent is portalled outside App's inert shell. Close it and
    // invalidate its request before a Project/Workspace lifecycle can replace
    // the backing database scope.
    loadGenerationRef.current += 1;
    setLoading(false);
    setOpen(false);
  }, [lifecycleLocked]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && isQuiescenceLeaseActive()) return;
      setOpen(nextOpen);
      if (nextOpen) void loadReader();
      else {
        loadGenerationRef.current += 1;
        setLoading(false);
      }
    },
    [loadReader],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="flex shrink-0 justify-end border-b border-border/50 px-3 py-1">
        <DialogTrigger asChild>
          <button
            type="button"
            disabled={lifecycleLocked}
            aria-disabled={lifecycleLocked || undefined}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {t("editor.a11y.openLinearReader")}
          </button>
        </DialogTrigger>
      </div>
      <DialogContent className="flex max-h-[90vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("editor.a11y.linearReaderTitle")}</DialogTitle>
          <DialogDescription>
            {t("editor.a11y.linearReaderDescription", {
              count: scenes.length,
            })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p
            role="status"
            className="py-8 text-center text-sm text-muted-foreground"
          >
            {t("editor.a11y.linearReaderLoading")}
          </p>
        ) : error ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3"
          >
            <p className="text-sm text-destructive">
              {t("editor.a11y.linearReaderFailed")}
            </p>
            <button
              type="button"
              disabled={lifecycleLocked}
              className="mt-2 rounded border border-border px-2 py-1 text-xs"
              onClick={() => void loadReader()}
            >
              {t("editor.a11y.linearReaderRetry")}
            </button>
          </div>
        ) : (
          <ol
            className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-3"
            aria-label={t("editor.a11y.linearReaderListLabel")}
          >
            {readerScenes.map((scene) => (
              <li key={scene.id}>
                <article aria-labelledby={`linear-reader-${scene.id}`}>
                  <h2
                    id={`linear-reader-${scene.id}`}
                    className="mb-2 border-b border-border pb-1 text-base font-medium"
                  >
                    {scene.title || t("editor.a11y.untitledScene")}
                  </h2>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {scene.text || t("editor.a11y.emptyScene")}
                  </p>
                  {scene.source === "live" && (
                    <span className="sr-only">
                      {t("editor.a11y.unsavedContent")}
                    </span>
                  )}
                </article>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
