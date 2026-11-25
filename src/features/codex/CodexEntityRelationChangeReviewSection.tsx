import { useEffect, useState } from "react";
import {
  readNir1ChangeReview,
  type Nir1ChangeReview,
  type Nir1ChangeReviewEvidenceChangeKind,
  type Nir1ChangeReviewObject,
  type Nir1ChangeReviewObjectChangeKind,
} from "@/features/narrative-semantic-core/nir1ChangeReviewApi";
import type { Nir1EntityRelationRevisionReadResult } from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";
import { useWorkspaceStore } from "@/features/workspace/store";

// 文言は利用者が確認したもの（docs/plans/m4-change-review-screen-draft.md §4・§6）。
// `removed` は出さない（選んでいないだけの項目を消えたと伝えないため。DR-M4PF-9）。
const OBJECT_LABELS: Record<
  Exclude<Nir1ChangeReviewObjectChangeKind, "removed">,
  string
> = {
  added: "今回はじめて入りました",
  "content-changed": "元の項目が更新されています",
  unchanged: "変化はありません",
  unresolved: "前の版を確かめられません",
};

const EVIDENCE_LABELS: Record<Nir1ChangeReviewEvidenceChangeKind, string> = {
  unchanged: "引用は同じです",
  relocated: "引用の位置が変わりました",
  lost: "引用がなくなりました",
  gained: "新しい引用です",
};

type Loaded =
  | { readonly key: string; readonly review: Nir1ChangeReview }
  | { readonly key: string; readonly review: null };

function displayName(
  identity: string,
  result: Nir1EntityRelationRevisionReadResult,
): { name: string; kind: string | null } {
  const entityName = (entityId: string) =>
    result.entities.find((entity) => entity.entityId === entityId)?.label ??
    entityId;
  if (identity.startsWith("codex-relation:")) {
    const edgeId = identity.slice("codex-relation:".length);
    const relation = result.relations.find((item) => item.edgeId === edgeId);
    if (relation) {
      return {
        name: `${entityName(relation.fromEntityId)} → ${entityName(relation.toEntityId)}`,
        kind: "関係",
      };
    }
  }
  if (identity.startsWith("codex:")) {
    const entityId = identity.slice("codex:".length);
    const entity = result.entities.find((item) => item.entityId === entityId);
    if (entity) return { name: entity.label, kind: entity.entityType };
  }
  return { name: identity, kind: null };
}

function ChangeRow({
  object,
  result,
}: {
  readonly object: Nir1ChangeReviewObject & {
    readonly change: keyof typeof OBJECT_LABELS;
  };
  readonly result: Nir1EntityRelationRevisionReadResult;
}) {
  const { name, kind } = displayName(object.identity, result);
  return (
    <li
      className="rounded bg-muted/40 px-2 py-1 text-xs"
      data-testid={`nir1-change-row-${object.identity}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span>
          <span className="font-medium">{name}</span>
          {kind && <span className="ml-1 text-muted-foreground">({kind})</span>}
        </span>
        <span>{OBJECT_LABELS[object.change]}</span>
      </div>
      {!object.evidenceWithheld && object.evidence.length > 0 && (
        <ul className="mt-1 border-l border-border pl-2 text-muted-foreground">
          {object.evidence.map((evidence, index) => (
            <li
              key={`${evidence.sourceRef}:${index}`}
              className="flex flex-wrap items-baseline justify-between gap-x-3"
            >
              <span>「{evidence.quote}」</span>
              <span>{EVIDENCE_LABELS[evidence.change]}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * 今の版と、同じ項目を含む前に承認した版との違いを出す（読むだけ）。
 * 版や workspace が変わった後に届いた応答は捨てる。
 */
export function CodexEntityRelationChangeReviewSection({
  result,
}: {
  readonly result: Nir1EntityRelationRevisionReadResult;
}) {
  const workspacePath = useWorkspaceStore((s) => s.activeWorkspacePath);
  const workspaceOpenRevision = useWorkspaceStore(
    (s) => s.workspaceOpenRevision,
  );
  const { projectId, revisionId } = result;
  const key = JSON.stringify([
    workspacePath,
    workspaceOpenRevision,
    projectId,
    revisionId,
  ]);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!workspacePath) return;
    let cancelled = false;
    const settle = (review: Nir1ChangeReview | null) => {
      if (!cancelled) setLoaded({ key, review });
    };
    readNir1ChangeReview({
      expectedWorkspacePath: workspacePath,
      projectId,
      revisionId,
    }).then(
      (response) =>
        settle(
          response.status === "available" &&
            response.result.revisionId === revisionId
            ? response.result
            : null,
        ),
      () => settle(null),
    );
    return () => {
      cancelled = true;
    };
  }, [key, workspacePath, projectId, revisionId]);

  // 読み終わるまでは欄を出さない。古い key の結果も出さない。
  if (loaded === null || loaded.key !== key) return null;

  const review = loaded.review;
  const objects =
    review?.objects.filter(
      (
        object,
      ): object is Nir1ChangeReviewObject & {
        change: keyof typeof OBJECT_LABELS;
      } => object.change !== "removed",
    ) ?? [];
  const nothingToCompare =
    review !== null &&
    review.previousRevisionIds.length === 0 &&
    !objects.some((object) => object.change === "unresolved");
  const hasUpdated =
    !nothingToCompare &&
    objects.some((object) => object.change === "content-changed");

  return (
    <section
      className="flex flex-col gap-1 border-t border-border/60 pt-2"
      aria-label="前に承認した版との違い"
      data-testid="nir1-change-review"
    >
      <h4 className="text-xs font-semibold">前に承認した版との違い</h4>
      {review === null ? (
        <p className="text-xs text-muted-foreground">違いを表示できません</p>
      ) : nothingToCompare ? (
        <p className="text-xs text-muted-foreground">
          比べる承認済みの版がありません
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {objects.map((object) => (
            <ChangeRow key={object.identity} object={object} result={result} />
          ))}
        </ul>
      )}
      {hasUpdated && (
        <p className="text-xs text-muted-foreground">
          ※「更新されています」は、保存し直しただけでも表示します
        </p>
      )}
    </section>
  );
}
