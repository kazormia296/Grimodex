import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useCodexStore } from "./codexStore";
import { listCodexRelations, type CodexRelationRow } from "./codexRelationApi";
import { subscribeCodexRelationsChanged } from "./codexRelationEvents";
import {
  computeCodexIntegrityIssues,
  type CodexIntegrityIssue,
} from "./codexIntegrity";

/**
 * Codex の内部整合性 (別名衝突・重複/自己参照リレーション) を一覧する折りたたみ
 * レポート。問題が 0 件のときは何も描画しない (パネルを汚さない)。各問題行のエントリ名は
 * クリックで該当エントリを選択する。read-only — 検出のみで自動修正はしない。
 */
export function CodexIntegrityReport() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const entries = useCodexStore((s) => s.entries);
  const [relations, setRelations] = useState<CodexRelationRow[]>([]);
  const [expanded, setExpanded] = useState(false);

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

  if (issues.length === 0) return null;

  return (
    <div className="mx-2 my-1 rounded border border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
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
          {issues.length}
        </span>
      </button>

      {expanded && (
        <ul className="max-h-48 overflow-y-auto border-t border-amber-500/20 px-2 py-1">
          {issues.map((issue) => (
            <li key={issueKey(issue)} className="py-1 text-[11px]">
              <IssueRow
                issue={issue}
                nameOf={(id) => nameById.get(id) ?? id}
                t={t}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function issueKey(issue: CodexIntegrityIssue): string {
  switch (issue.kind) {
    case "alias-collision":
      return `alias:${issue.normalized}`;
    case "duplicate-relation":
      return `dup:${issue.entryIds.join("|")}:${issue.relationType}`;
    case "self-relation":
      return `self:${issue.entryId}:${issue.relationType}`;
  }
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
      className="rounded px-0.5 font-medium text-amber-800 underline-offset-2 hover:underline dark:text-amber-200"
    >
      {label}
    </button>
  );
}
