import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { isLicenseRestrictedError } from "@/features/license/gate";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "./codexStore";
import {
  extractCodexCandidates,
  type CodexCandidate,
} from "./candidateExtractor";
import { activeCandidates, candidateKey } from "./codexCandidates";
import { judgeCandidates, type CandidateJudgment } from "./candidateJudgment";
import { parseAliases } from "./codexMatcher";
import {
  loadDismissedCandidateKeys,
  saveDismissedCandidateKeys,
} from "./codexCandidateDismissals";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * 本文に出てくるが Codex 未登録の固有名詞を「未確定候補」として一覧する折りたたみ
 * レポート (形態素×LLM の形態素半分 = 決定的な全件列挙)。候補 0 件なら何も描画しない。
 *
 * 各候補は受理 (Codex エントリ化 → 詳細を開いて種別/説明を調整) または却下できる。
 * 却下状態は project 単位で永続化し、毎回同じ語を提案しない。受理した候補は entries
 * 更新で自動的に一覧から消える。read-only スキャン — 自動で Codex には書かない。
 *
 * 却下集合の更新機構 (楽観 ref + 直列化 last-write-wins + undo) は
 * [[CodexIntegrityReport]] と同設計。
 */
export function CodexCandidatesReport() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((s) => s.entries);
  const create = useCodexStore((s) => s.create);
  const update = useCodexStore((s) => s.update);

  const [candidates, setCandidates] = useState<CodexCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [judging, setJudging] = useState(false);
  const [judgments, setJudgments] = useState<Map<string, CandidateJudgment>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const dismissedRef = useRef<Set<string>>(dismissed);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const commit = useCallback((next: Set<string>) => {
    dismissedRef.current = next;
    setDismissed(next);
  }, []);

  // 候補を本文スキャンで取得 (project 切替 / 手動リフレッシュで再実行)。
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
    // project 切替時は旧 project の候補/判定を即クリアしてから読み直す
    // (新スキャン完了まで旧候補が一瞬残るのを防ぐ)。手動リフレッシュ (reload 直呼び)
    // はクリアしないのでスピナー中に旧一覧が見えたままになる。
    setCandidates([]);
    setJudgments(new Map());
    reload();
  }, [projectId, reload]);

  // 却下状態を project ごとにロード。切替時は一旦空に戻してから読み直す。
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

  // 既に Codex にあるもの (受理済み) を除外。
  const active = useMemo(
    () => activeCandidates(candidates, entries),
    [candidates, entries],
  );
  const visible = useMemo(
    () => active.filter((c) => !dismissed.has(candidateKey(c.surface))),
    [active, dismissed],
  );
  const hiddenActiveCount = active.length - visible.length;

  // AI 判定 (B2): 表示中の候補を一括で種別分類/別名検出させる。
  const handleJudge = useCallback(async () => {
    if (judging || visible.length === 0) return;
    setJudging(true);
    try {
      const result = await judgeCandidates(visible, entries);
      setJudgments(result);
    } catch (e) {
      if (!isLicenseRestrictedError(e)) {
        toast.error(t("codex.candidates.judgeFailed"), {
          description: String(e),
        });
      }
    } finally {
      setJudging(false);
    }
  }, [judging, visible, entries, t]);

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

  // 受理: AI 判定があれば種別/要約を使って作成 (無ければ character 既定)。
  // 「既存エントリ X の別名」と判定された場合は新規作成せず X の aliases に追記。
  // 受理後は entries 更新で activeCandidates から自動的に消える。create/update が
  // undo 履歴を積む。
  const handleAccept = useCallback(
    async (c: CodexCandidate) => {
      const judgment = judgments.get(candidateKey(c.surface));
      try {
        if (judgment?.aliasOfId) {
          const target = entries.find((e) => e.id === judgment.aliasOfId);
          if (target) {
            const aliases = parseAliases(target.aliases);
            if (!aliases.includes(c.surface)) {
              await update(target.id, {
                aliases: JSON.stringify([...aliases, c.surface]),
              });
            }
            useCodexStore.getState().requestSelectEntry(target.id);
            return;
          }
        }
        const entry = await create({
          type: judgment?.suggestedType ?? "character",
          name: c.surface,
          summary: judgment?.summary || undefined,
        });
        useCodexStore.getState().requestSelectEntry(entry.id);
      } catch (e) {
        // ライセンス制限は create/update 内の gate が既にトーストするので二重表示しない。
        if (!isLicenseRestrictedError(e)) {
          toast.error(t("codex.candidates.acceptFailed"), {
            description: String(e),
          });
        }
      }
    },
    [create, update, entries, judgments, t],
  );

  if (visible.length === 0 && hiddenActiveCount === 0) return null;

  // 全件却下: 控えめなバーで件数と再表示導線だけ残す。
  if (visible.length === 0) {
    return (
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
    );
  }

  return (
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
            {visible.map((c) => {
              const j = judgments.get(candidateKey(c.surface));
              const aliasName = j?.aliasOfId
                ? entries.find((e) => e.id === j.aliasOfId)?.name
                : undefined;
              return (
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
                      {j && (
                        <span className="shrink-0 rounded bg-sky-500/15 px-1 text-[9px] uppercase tracking-wide">
                          {t(`codex.candidates.type.${j.suggestedType}`)}
                        </span>
                      )}
                    </span>
                    {j && aliasName ? (
                      <span className="block truncate text-[10px] text-amber-700 dark:text-amber-300">
                        {t("codex.candidates.aliasHint", { name: aliasName })}
                      </span>
                    ) : j && j.summary ? (
                      <span className="block truncate text-[10px] text-sky-700/70 dark:text-sky-300/70">
                        {j.summary}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleAccept(c)}
                    title={
                      aliasName
                        ? t("codex.candidates.acceptAlias", { name: aliasName })
                        : t("codex.candidates.accept")
                    }
                    aria-label={t("codex.candidates.accept")}
                    data-testid="codex-candidates-accept"
                    className={`flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 font-medium text-sky-700 hover:bg-sky-500/20 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100 ${FOCUS_RING}`}
                  >
                    <Plus className="h-3 w-3" />
                  </button>
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
              );
            })}
          </ul>
          <div className="flex items-center gap-2 border-t border-sky-500/20 px-2 py-1">
            <button
              type="button"
              onClick={() => void handleJudge()}
              disabled={judging || loading}
              data-testid="codex-candidates-judge"
              className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-sky-700/90 hover:bg-sky-500/20 disabled:opacity-50 dark:text-sky-200 ${FOCUS_RING}`}
            >
              <Sparkles
                className={`h-3 w-3 ${judging ? "animate-pulse" : ""}`}
              />
              {t("codex.candidates.judge")}
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
  );
}
