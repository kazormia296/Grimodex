import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "./codexStore";
import { listCodexRelations, type CodexRelationRow } from "./codexRelationApi";
import { subscribeCodexRelationsChanged } from "./codexRelationEvents";
import {
  computeCodexIntegrityIssues,
  integrityIssueKey,
  type CodexIntegrityIssue,
} from "./codexIntegrity";
import {
  loadDismissedIntegrityKeys,
  saveDismissedIntegrityKeys,
} from "./codexIntegrityDismissals";

// 共通の focus リング (生 <button> は Button コンポーネントの focus-visible を継承しない)。
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/**
 * Codex の内部整合性 (別名衝突・重複/自己参照リレーション) を一覧する折りたたみ
 * レポート。問題が 0 件のときは何も描画しない (パネルを汚さない)。各問題行のエントリ名は
 * クリックで該当エントリを選択する。read-only — 検出のみで自動修正はしない。
 *
 * 各指摘は × で「非表示 (dismiss)」にでき、状態は project 単位で永続化する
 * (意図的な別名共有などを毎回警告されないため)。非表示中の指摘は折りたたみ末尾の
 * 「再表示」で戻せる。全件非表示になったら控えめなバーだけ残し、戻す導線を確保する。
 *
 * 非表示集合の更新は「同期的に ref を進める楽観更新 + 直列化した last-write-wins
 * 永続化」で扱う。これにより (a) 連続クリックでも取りこぼさず累積し、(b) dismiss 直後の
 * undo が古い保存に上書きされず、(c) プロジェクト切替中の遅延保存が別 project の表示状態を
 * 汚さない (保存先 pid を固定し、UI 反映は現在 project と一致するときだけ行う)。
 */
export function CodexIntegrityReport() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((s) => s.entries);
  const [relations, setRelations] = useState<CodexRelationRow[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  // 同期的な権威コピー (連続ミューテーションが互いの結果を即座に見られるように)。
  const dismissedRef = useRef<Set<string>>(dismissed);
  // 常に最新の projectId。遅延コールバックが「今どの project を見ているか」を判定する。
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  // 永続化を投入順に直列化する (last-write-wins を保証し、out-of-order 上書きを防ぐ)。
  const writeChainRef = useRef<Promise<unknown>>(Promise.resolve());

  // ref と state を同時に進める (ref=同期的真実 / state=描画トリガ)。
  const commit = useCallback((next: Set<string>) => {
    dismissedRef.current = next;
    setDismissed(next);
  }, []);

  // relations は store に無いので自前ロード。relation 変更イベントで再取得する。
  // entry 側の変更 (別名衝突) は entries 購読で自動再計算される。
  // projectId を deps に入れることで、プロジェクト切替時に再ロード+再購読する
  // (パネルが keepalive で remount されないため deps=[] だと旧 project に張り付く)。
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listCodexRelations(projectId)
        .then((r) => {
          if (!cancelled) setRelations(r);
        })
        .catch(() => {
          if (!cancelled) setRelations([]);
        });
    };
    load();
    const unsub = subscribeCodexRelationsChanged(projectId, load);
    return () => {
      cancelled = true;
      unsub();
    };
  }, [projectId]);

  // 非表示状態を project ごとにロード。切替時は一旦空に戻してから読み直す
  // (前 project の非表示が一瞬リークしないように)。
  useEffect(() => {
    let cancelled = false;
    commit(new Set());
    if (!projectId) return;
    loadDismissedIntegrityKeys(projectId)
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

  const nameById = useMemo(
    () => new Map(entries.map((e) => [e.id, e.name])),
    [entries],
  );

  const issues = useMemo(() => {
    // 削除済みエントリを指す stale relation (FK CASCADE 済みだがロード後に消えた等) を除外。
    const liveIds = new Set(entries.map((e) => e.id));
    const liveRelations = relations.filter(
      (r) => liveIds.has(r.fromCodexId) && liveIds.has(r.toCodexId),
    );
    return computeCodexIntegrityIssues({ entries, relations: liveRelations });
  }, [entries, relations]);

  const visibleIssues = useMemo(
    () => issues.filter((i) => !dismissed.has(integrityIssueKey(i))),
    [issues, dismissed],
  );
  // 「今表示できる実在の指摘のうち、非表示にされている件数」。
  // dismissed 集合に残る orphan キー (解消済みの指摘) はここに含めない。
  const hiddenActiveCount = issues.length - visibleIssues.length;

  // 指定 pid の保存を直列キューに積む。失敗時は、現在もその project を見ていて、かつ
  // 「今まさに画面に出ている状態 (= value) を書こうとした write」だったときだけ、トースト
  // を出し DB の真実へ巻き戻す。より新しいミューテーションが ref を置き換えていたら、古い
  // 失敗で新しい意図を潰さない (その新ミューテーション自身の write が後続で真実を確定する)。
  // 識別は Set のオブジェクト同一性で行う (commit した実体そのものか)。
  const persistValue = useCallback(
    (pid: string, value: Set<string>): Promise<void> => {
      const run = writeChainRef.current
        .catch(() => {})
        .then(() => saveDismissedIntegrityKeys(pid, value))
        .catch((err) => {
          if (projectIdRef.current !== pid || dismissedRef.current !== value) {
            return;
          }
          toast.error(t("codex.integrity.dismissFailed"), {
            description: String(err),
          });
          return loadDismissedIntegrityKeys(pid)
            .then((keys) => {
              // reload 中に新ミューテーションが来ていたら適用しない (再判定)。
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

  // 非表示集合を next へ更新し、永続化し、undo/redo を履歴に積む。
  const mutate = useCallback(
    (next: Set<string>, prev: Set<string>, label: string) => {
      const pid = projectIdRef.current;
      if (!pid) return;
      commit(next); // 楽観更新 (同期)
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
    (key: string) => {
      const prev = dismissedRef.current;
      const next = new Set(prev);
      next.add(key);
      mutate(next, prev, t("codex.integrity.historyDismiss"));
    },
    [mutate, t],
  );

  const handleRestoreAll = useCallback(() => {
    // 非表示を全解除 (実在指摘の再表示 + 解消済み orphan キーの掃除を兼ねる)。
    mutate(
      new Set(),
      dismissedRef.current,
      t("codex.integrity.historyRestore"),
    );
  }, [mutate, t]);

  // 表示すべき指摘も、非表示中の実在指摘も無ければ何も描画しない。
  if (visibleIssues.length === 0 && hiddenActiveCount === 0) return null;

  // 全件非表示: 控えめなバーで件数と再表示導線だけ残す (警告色は使わない)。
  if (visibleIssues.length === 0) {
    return (
      <div
        className="mx-2 my-1 flex items-center gap-1.5 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-xs text-muted-foreground"
        data-testid="codex-integrity-all-hidden"
      >
        <EyeOff className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {t("codex.integrity.allHidden", { count: hiddenActiveCount })}
        </span>
        <button
          type="button"
          onClick={handleRestoreAll}
          data-testid="codex-integrity-restore"
          title={t("codex.integrity.restoreHidden", {
            count: hiddenActiveCount,
          })}
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-muted hover:text-foreground ${FOCUS_RING}`}
        >
          <Eye className="h-3 w-3" />
          {t("codex.integrity.show")}
        </button>
      </div>
    );
  }

  return (
    <div className="mx-2 my-1 rounded border border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-center gap-1.5 px-2 py-1.5 text-left ${FOCUS_RING}`}
        aria-expanded={expanded}
        data-testid="codex-integrity-toggle"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <span className="flex-1 text-xs font-semibold">
          {t("codex.integrity.title")}
        </span>
        <span className="shrink-0 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
          {visibleIssues.length}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-amber-500/20">
          <ul className="max-h-48 overflow-y-auto px-2 py-1">
            {visibleIssues.map((issue) => {
              const key = integrityIssueKey(issue);
              return (
                <li
                  key={key}
                  className="flex items-start gap-1 py-1 text-[11px]"
                >
                  <span className="min-w-0 flex-1">
                    <IssueRow
                      issue={issue}
                      nameOf={(id) => nameById.get(id) ?? id}
                      t={t}
                    />
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDismiss(key)}
                    title={t("codex.integrity.dismiss")}
                    aria-label={t("codex.integrity.dismiss")}
                    data-testid="codex-integrity-dismiss"
                    className={`shrink-0 rounded p-1.5 text-amber-700/70 hover:bg-amber-500/20 hover:text-amber-900 dark:hover:text-amber-100 ${FOCUS_RING}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </li>
              );
            })}
          </ul>
          {hiddenActiveCount > 0 && (
            <div className="border-t border-amber-500/20 px-2 py-1">
              <button
                type="button"
                onClick={handleRestoreAll}
                data-testid="codex-integrity-restore"
                className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] text-amber-700/80 hover:bg-amber-500/20 dark:text-amber-300 ${FOCUS_RING}`}
              >
                <Eye className="h-3 w-3" />
                {t("codex.integrity.restoreHidden", {
                  count: hiddenActiveCount,
                })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IssueRow({
  issue,
  nameOf,
  t,
}: {
  issue: CodexIntegrityIssue;
  nameOf: (id: string) => string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  if (issue.kind === "alias-collision") {
    return (
      <span>
        <span className="font-medium">
          {t("codex.integrity.aliasCollision", {
            name: issue.surfaces[0].surface,
          })}
        </span>{" "}
        {issue.surfaces.map((s, i) => (
          <span key={s.entryId}>
            {i > 0 && <span className="text-amber-700/60">, </span>}
            <EntryLink id={s.entryId} label={nameOf(s.entryId)} />
          </span>
        ))}
      </span>
    );
  }
  if (issue.kind === "duplicate-relation") {
    return (
      <span>
        <span className="font-medium">
          {t("codex.integrity.duplicateRelation", {
            type: issue.relationType,
            count: issue.count,
          })}
        </span>{" "}
        <EntryLink id={issue.entryIds[0]} label={nameOf(issue.entryIds[0])} />
        <span className="text-amber-700/60"> ↔ </span>
        <EntryLink id={issue.entryIds[1]} label={nameOf(issue.entryIds[1])} />
      </span>
    );
  }
  return (
    <span>
      <span className="font-medium">
        {t("codex.integrity.selfRelation", { type: issue.relationType })}
      </span>{" "}
      <EntryLink id={issue.entryId} label={nameOf(issue.entryId)} />
    </span>
  );
}

/** クリックで該当 Codex エントリを選択する。 */
function EntryLink({ id, label }: { id: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => useCodexStore.getState().requestSelectEntry(id)}
      className={`rounded px-0.5 font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-200 ${FOCUS_RING}`}
    >
      {label}
    </button>
  );
}
