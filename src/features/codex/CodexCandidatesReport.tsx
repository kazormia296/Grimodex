import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Tags,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { isLicenseRestrictedError } from "@/features/license/gate";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "./codexStore";
import type { CodexCandidate } from "./candidateExtractor";
import { activeCandidates, candidateKey } from "./codexCandidates";
import { judgeCandidates, type CandidateJudgment } from "./candidateJudgment";
import { parseAliases } from "./codexMatcher";
import { isRelationalTerm } from "./extraction/relationalTerms";
import { rootCause } from "@/lib/debugLog";
import { isCodexStructureExtractionReviewEnabled } from "./codexStructureExtractionFlag";
import { useCodexCandidateHostStore } from "./codexCandidateHostStore";
import { useCodexCandidateDismissalActions } from "./useCodexCandidateDismissalActions";

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
 * Structure Extraction Dialog は開発フラグ / DEV でのみ追加導線として出す
 * （製品の唯一の受理経路にはしない）。
 */
export function CodexCandidatesReport() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((s) => s.entries);
  const create = useCodexStore((s) => s.create);
  const update = useCodexStore((s) => s.update);
  const scan = useCodexCandidateHostStore((s) => s.scan);
  const candidates = scan.candidates;
  const loading = scan.status === "scanning";
  const dismissed = useCodexCandidateHostStore((s) => s.dismissed);
  const generation = useCodexCandidateHostStore((s) => s.generation);
  const syncProject = useCodexCandidateHostStore((s) => s.syncProject);
  const requestScan = useCodexCandidateHostStore((s) => s.requestScan);
  const openStructureReview = useCodexCandidateHostStore(
    (s) => s.openStructureReview,
  );
  const { handleDismiss, handleRestoreAll } =
    useCodexCandidateDismissalActions();

  const [judging, setJudging] = useState(false);
  const [judgments, setJudgments] = useState<Map<string, CandidateJudgment>>(
    new Map(),
  );
  const [expanded, setExpanded] = useState(false);
  const structureReviewEnabled = isCodexStructureExtractionReviewEnabled();

  useEffect(() => {
    syncProject(projectId);
    // 開くたびに走査し直す（以前の挙動）。走査中なら合流し、本文の変更を拾う。
    void requestScan({ refresh: true });
  }, [projectId, requestScan, syncProject]);

  // 候補の作品切替・再スキャン時は、前の集合に対する AI 判定を捨てる。
  useEffect(() => setJudgments(new Map()), [generation]);

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
          description: rootCause(e),
        });
      }
    } finally {
      setJudging(false);
    }
  }, [judging, visible, entries, t]);

  // 受理 (新規作成): AI 判定があれば種別/要約を使って作成 (無ければ character 既定)。
  // AI が「別名」と判定していても、このボタンはあえて**新規エントリ**を作る
  // (別名登録は専用の fix ボタン → handleRegisterAlias)。受理後は entries 更新で
  // activeCandidates から自動的に消える。create が undo 履歴を積む。
  const handleCreateEntry = useCallback(
    async (c: CodexCandidate) => {
      const judgment = judgments.get(candidateKey(c.surface));
      try {
        const entry = await create({
          type: judgment?.suggestedType ?? "character",
          name: c.surface,
          summary: judgment?.summary || undefined,
        });
        useCodexStore.getState().requestSelectEntry(entry.id);
      } catch (e) {
        // ライセンス制限は create 内の gate が既にトーストするので二重表示しない。
        if (!isLicenseRestrictedError(e)) {
          toast.error(t("codex.candidates.acceptFailed"), {
            description: String(e),
          });
        }
      }
    },
    [create, judgments, t],
  );

  // 別名登録 (fix): AI が「既存エントリ X の別名」と判定した候補を、新規作成せず
  // X の aliases に追記する。対象が見つからない (判定が外れた/対象が削除された) 場合は
  // 新規作成にフォールバック。重複追記は正規化キー (NFC/大小揺れ含む) で防ぐ。
  const handleRegisterAlias = useCallback(
    async (c: CodexCandidate) => {
      const judgment = judgments.get(candidateKey(c.surface));
      const target = judgment?.aliasOfId
        ? entries.find((e) => e.id === judgment.aliasOfId)
        : undefined;
      if (!target) {
        await handleCreateEntry(c);
        return;
      }
      try {
        const aliases = parseAliases(target.aliases);
        const key = candidateKey(c.surface);
        const dup =
          candidateKey(target.name ?? "") === key ||
          aliases.some((a) => candidateKey(a) === key);
        if (!dup) {
          await update(target.id, {
            aliases: JSON.stringify([...aliases, c.surface]),
          });
        }
        useCodexStore.getState().requestSelectEntry(target.id);
      } catch (e) {
        // ライセンス制限は update 内の gate が既にトーストするので二重表示しない。
        if (!isLicenseRestrictedError(e)) {
          toast.error(t("codex.candidates.acceptFailed"), {
            description: String(e),
          });
        }
      }
    },
    [entries, judgments, update, handleCreateEntry, t],
  );

  if (visible.length === 0 && hiddenActiveCount === 0) return null;

  // 全件却下: 控えめなバーで件数と再表示導線だけ残す。
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
              {visible.map((c) => {
                const j = judgments.get(candidateKey(c.surface));
                // 関係の呼び名（姉ちゃん・あなた 等）は話し手で指す人が変わるので、
                // AI が別名を勧めても別名ボタン（handleRegisterAlias への唯一の入口）を出さない。
                const relationalAliasSuppressed =
                  !!j?.aliasOfId && isRelationalTerm(c.surface);
                const aliasName =
                  j?.aliasOfId && !relationalAliasSuppressed
                    ? entries.find((e) => e.id === j.aliasOfId)?.name
                    : undefined;
                return (
                  <li
                    key={candidateKey(c.surface)}
                    className="flex items-center gap-1 py-1 text-[11px]"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1">
                        <span className="truncate font-medium">
                          {c.surface}
                        </span>
                        <span className="shrink-0 text-sky-700/70 dark:text-sky-300/70 tabular-nums">
                          {t("codex.candidates.occurrences", {
                            count: c.count,
                          })}
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
                      ) : relationalAliasSuppressed ? (
                        <span
                          className="block truncate text-[10px] text-sky-700/70 dark:text-sky-300/70"
                          data-testid="codex-candidates-relational-note"
                        >
                          {t("codex.candidates.relationalAliasNote", {
                            surface: c.surface,
                          })}
                        </span>
                      ) : j && j.summary ? (
                        <span className="block truncate text-[10px] text-sky-700/70 dark:text-sky-300/70">
                          {j.summary}
                        </span>
                      ) : null}
                    </span>
                    {aliasName && (
                      <button
                        type="button"
                        onClick={() => void handleRegisterAlias(c)}
                        title={t("codex.candidates.acceptAlias", {
                          name: aliasName,
                        })}
                        aria-label={t("codex.candidates.acceptAlias", {
                          name: aliasName,
                        })}
                        data-testid="codex-candidates-register-alias"
                        className={`flex shrink-0 items-center gap-0.5 rounded px-1.5 py-1 font-medium text-amber-700 hover:bg-amber-500/20 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100 ${FOCUS_RING}`}
                      >
                        <Link2 className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleCreateEntry(c)}
                      title={
                        aliasName
                          ? t("codex.candidates.acceptNew")
                          : t("codex.candidates.accept")
                      }
                      aria-label={
                        aliasName
                          ? t("codex.candidates.acceptNew")
                          : t("codex.candidates.accept")
                      }
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
                {judging ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="h-3 w-3" />
                )}
                {judging
                  ? t("codex.candidates.judging")
                  : t("codex.candidates.judge")}
              </button>
              {structureReviewEnabled && (
                <button
                  type="button"
                  onClick={openStructureReview}
                  data-testid="codex-candidates-open-structure"
                  className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-medium text-sky-700/90 hover:bg-sky-500/20 dark:text-sky-200 ${FOCUS_RING}`}
                >
                  <Sparkles className="h-3 w-3" />
                  {t("codex.candidates.openStructureExtract", {
                    defaultValue: "構造抽出でレビュー",
                  })}
                </button>
              )}
              <button
                type="button"
                onClick={() => void requestScan({ force: true })}
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
    </>
  );
}
