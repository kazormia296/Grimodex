import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  RefreshCw,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "./codexStore";
import {
  extractCodexCandidates,
  type CodexCandidate,
} from "./candidateExtractor";
import { activeCandidates, candidateKey } from "./codexCandidates";
import {
  loadDismissedCandidateKeys,
  saveDismissedCandidateKeys,
} from "./codexCandidateDismissals";
import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Unregistered proper-noun candidates (deterministic scan).
 *
 * PR6 cutover: AI judge + direct createEntry mutation removed. Accept path is
 * CodexStructureExtractDialog (Proposal Review → Atomic Commit).
 */
export function CodexCandidatesReport() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((s) => s.entries);

  const [candidates, setCandidates] = useState<CodexCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [structureOpen, setStructureOpen] = useState(false);

  const dismissedRef = useRef<Set<string>>(dismissed);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: Set<string>) => {
    dismissedRef.current = next;
    setDismissed(next);
  }, []);

  const reload = useCallback(() => {
    const pid = projectIdRef.current;
    if (!pid) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    extractCodexCandidates(pid)
      .then((c) => {
        if (projectIdRef.current === pid) setCandidates(c);
      })
      .catch(() => {
        if (projectIdRef.current === pid) setCandidates([]);
      })
      .finally(() => {
        if (projectIdRef.current === pid) setLoading(false);
      });
  }, []);

  useEffect(() => {
    setCandidates([]);
    reload();
  }, [projectId, reload]);

  useEffect(() => {
    let cancelled = false;
    commit(new Set());
    if (!projectId) return;
    loadDismissedCandidateKeys(projectId)
      .then((keys) => {
        if (!cancelled) commit(keys);
      })
      .catch(() => {
        if (!cancelled) commit(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, commit]);

  const active = useMemo(
    () => activeCandidates(candidates, entries),
    [candidates, entries],
  );
  const visible = useMemo(
    () => active.filter((c) => !dismissed.has(candidateKey(c.surface))),
    [active, dismissed],
  );
  const hiddenActiveCount = active.length - visible.length;

  const persistValue = useCallback(
    (pid: string, value: Set<string>): Promise<void> => {
      const run = writeChainRef.current
        .catch(() => {})
        .then(() => saveDismissedCandidateKeys(pid, value))
        .catch((err) => {
          if (projectIdRef.current !== pid || dismissedRef.current !== value) {
            return;
          }
          toast.error(t("codex.candidates.dismissFailed"), {
            description: String(err),
          });
          return loadDismissedCandidateKeys(pid)
            .then((keys) => {
              if (
                projectIdRef.current === pid &&
                dismissedRef.current === value
              ) {
                commit(keys);
              }
            })
            .catch(() => {});
        });
      writeChainRef.current = run;
      return run;
    },
    [t, commit],
  );

  const mutate = useCallback(
    (next: Set<string>, prev: Set<string>, label: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      commit(next);
      void persistValue(pid, next);
      if (useGlobalHistoryStore.getState().isReplaying) return;
      useGlobalHistoryStore.getState().push({
        kind: "codex",
        label,
        async undo() {
          if (projectIdRef.current === pid) commit(prev);
          await persistValue(pid, prev);
        },
        async redo() {
          if (projectIdRef.current === pid) commit(next);
          await persistValue(pid, next);
        },
      });
    },
    [commit, persistValue],
  );

  const handleDismiss = useCallback(
    (surface: string) => {
      const prev = dismissedRef.current;
      const next = new Set(prev);
      next.add(candidateKey(surface));
      mutate(next, prev, t("codex.candidates.historyDismiss"));
    },
    [mutate, t],
  );

  const handleRestoreAll = useCallback(() => {
    mutate(
      new Set(),
      dismissedRef.current,
      t("codex.candidates.historyRestore"),
    );
  }, [mutate, t]);

  if (visible.length === 0 && hiddenActiveCount === 0) return null;

  if (visible.length === 0) {
    return (
      <>
        <div
          className="mx-2 my-1 flex items-center gap-1.5 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground"
          data-testid="codex-candidates-all-hidden"
        >
          <EyeOff className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">
            {t("codex.candidates.allDismissed", { count: hiddenActiveCount })}
          </span>
          <button
            type="button"
            onClick={handleRestoreAll}
            data-testid="codex-candidates-restore"
            title={t("codex.candidates.restoreHidden", {
              count: hiddenActiveCount,
            })}
            className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-muted hover:text-foreground ${FOCUS_RING}`}
          >
            <Eye className="h-3 w-3" />
            {t("codex.candidates.show")}
          </button>
        </div>
        <CodexStructureExtractDialog
          open={structureOpen}
          onOpenChange={setStructureOpen}
        />
      </>
    );
  }

  return (
    <>
      <div className="mx-2 my-1 rounded border border-sky-500/40 bg-sky-500/5 text-sky-900 dark:text-sky-200">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left ${FOCUS_RING}`}
          aria-expanded={expanded}
          data-testid="codex-candidates-toggle"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )}
          <Tags className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
          <span className="flex-1 text-xs font-semibold">
            {t("codex.candidates.title")}
          </span>
          <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
            {visible.length}
          </span>
        </button>

        {expanded && (
          <div className="border-t border-sky-500/20">
            <ul className="max-h-48 overflow-y-auto px-2 py-1">
              {visible.map((c) => (
                <li
                  key={candidateKey(c.surface)}
                  className="flex items-center gap-1 py-1 text-[11px]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1">
                      <span className="truncate font-medium">{c.surface}</span>
                      <span className="shrink-0 text-sky-700/70 dark:text-sky-300/70 tabular-nums">
                        {t("codex.candidates.occurrences", { count: c.count })}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDismiss(c.surface)}
                    title={t("codex.candidates.dismiss")}
                    aria-label={t("codex.candidates.dismiss")}
                    data-testid="codex-candidates-dismiss"
                    className={`shrink-0 rounded p-1.5 text-sky-700/70 hover:bg-sky-500/20 hover:text-sky-900 dark:hover:text-sky-100 ${FOCUS_RING}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 border-t border-sky-500/20 px-2 py-1">
              <button
                type="button"
                onClick={() => setStructureOpen(true)}
                data-testid="codex-candidates-open-structure"
                className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-sky-700/90 hover:bg-sky-500/20 dark:text-sky-200 ${FOCUS_RING}`}
              >
                <Sparkles className="h-3 w-3" />
                {t("codex.candidates.openStructureExtract", {
                  defaultValue: "構造抽出でレビュー",
                })}
              </button>
              <button
                type="button"
                onClick={reload}
                disabled={loading}
                data-testid="codex-candidates-refresh"
                className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-sky-700/80 hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-300 ${FOCUS_RING}`}
              >
                <RefreshCw
                  className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
                />
                {t("codex.candidates.rescan")}
              </button>
              {hiddenActiveCount > 0 && (
                <button
                  type="button"
                  onClick={handleRestoreAll}
                  data-testid="codex-candidates-restore"
                  className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-sky-700/80 hover:bg-sky-500/20 dark:text-sky-300 ${FOCUS_RING}`}
                >
                  <Eye className="h-3 w-3" />
                  {t("codex.candidates.restoreHidden", {
                    count: hiddenActiveCount,
                  })}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      <CodexStructureExtractDialog
        open={structureOpen}
        onOpenChange={setStructureOpen}
      />
    </>
  );
}
