import type { Nir1EntityRelationRevisionReadResult } from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";
import { CodexEntityRelationRevisionReviewDecisionControls } from "./CodexEntityRelationRevisionReviewDecisionControls";

export type CodexEntityRelationReviewDecision =
  | "approved"
  | "rejected"
  | "deferred";

export type CodexEntityRelationReviewStatus =
  | "draft"
  | "available"
  | "unavailable";

export interface CodexEntityRelationRevisionReviewPanelProps {
  readonly runId: string;
  readonly status: CodexEntityRelationReviewStatus;
  readonly result: Nir1EntityRelationRevisionReadResult | null;
  readonly decision: CodexEntityRelationReviewDecision | null;
  readonly unavailableReason?: string | null;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onDecision?: (decision: CodexEntityRelationReviewDecision) => void;
  readonly onReplace?: () => void;
}

function statusLabel(
  status: CodexEntityRelationReviewStatus,
  decision: CodexEntityRelationReviewDecision | null,
): string {
  if (status === "available") return "利用可能";
  if (status === "unavailable") return "利用不可";
  if (decision === "approved") return "承認済み・再評価中";
  if (decision === "rejected") return "明示却下済み";
  if (decision === "deferred") return "保留済み";
  return "未承認（利用不可）";
}

/** Dedicated typed review projection. Scope/source tokens stay Native-only. */
export function CodexEntityRelationRevisionReviewPanel({
  runId,
  status,
  result,
  decision,
  unavailableReason,
  busy = false,
  error = null,
  onDecision,
  onReplace,
}: CodexEntityRelationRevisionReviewPanelProps) {
  const entityLabels = new Map(
    result?.entities.map((entity) => [entity.entityId, entity.label]) ?? [],
  );
  const canDecide = status === "draft" && decision === null && !busy;
  const canCancel =
    status === "available" && decision === "approved" && Boolean(onDecision);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded border border-border/70 p-3"
      data-testid="nir1-entity-relation-review-panel"
      data-run-id={runId}
      aria-label="Entity/Relation 専用レビュー"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
        <div>
          <h3 className="text-sm font-semibold">
            Entity / Relation 専用レビュー
          </h3>
          <p className="text-xs text-muted-foreground">
            Native が解決した入力を確認し、明示的に判断してください。
          </p>
        </div>
        <span
          className="rounded bg-muted px-2 py-1 text-xs font-medium"
          data-testid="nir1-typed-status"
        >
          {statusLabel(status, decision)}
        </span>
      </div>

      {unavailableReason && (
        <p
          className="text-xs text-muted-foreground"
          data-testid="nir1-typed-unavailable-reason"
        >
          理由: {unavailableReason}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {result && (
        <>
          <p className="text-xs text-muted-foreground">
            対象 Scene: {result.sceneId}
          </p>
          <div
            className="flex flex-col gap-1"
            data-testid="nir1-typed-entities"
          >
            <h4 className="text-xs font-semibold">
              Entity ({result.entities.length})
            </h4>
            <ul className="flex flex-col gap-1">
              {result.entities.map((entity) => (
                <li
                  key={entity.entityId}
                  className="rounded bg-muted/40 px-2 py-1 text-xs"
                  data-testid={`nir1-typed-entity-row-${entity.entityId}`}
                >
                  <span className="font-medium">{entity.label}</span>
                  <span className="ml-1 text-muted-foreground">
                    ({entity.entityType})
                  </span>
                  {entity.evidence.length > 0 && (
                    <ul
                      className="mt-1 border-l border-border pl-2 text-muted-foreground"
                      data-testid="nir1-typed-evidence"
                    >
                      {entity.evidence.map((evidence) => (
                        <li key={evidence.evidenceId}>「{evidence.quote}」</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div
            className="flex flex-col gap-1"
            data-testid="nir1-typed-relations"
          >
            <h4 className="text-xs font-semibold">
              Relation ({result.relations.length})
            </h4>
            {result.relations.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Relation はありません。
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {result.relations.map((relation) => (
                  <li
                    key={relation.edgeId}
                    className="rounded bg-muted/40 px-2 py-1 text-xs"
                    data-testid={`nir1-typed-relation-row-${relation.edgeId}`}
                  >
                    <span className="font-medium">
                      {entityLabels.get(relation.fromEntityId) ??
                        relation.fromEntityId}{" "}
                      {relation.relationType}{" "}
                      {entityLabels.get(relation.toEntityId) ??
                        relation.toEntityId}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      ({relation.evidenceIds.length} Evidence)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {onDecision && (
        <CodexEntityRelationRevisionReviewDecisionControls
          canDecide={canDecide}
          canCancel={canCancel}
          busy={busy}
          onDecision={onDecision}
        />
      )}
      {status === "unavailable" && result && onReplace && (
        <div className="mt-auto flex flex-wrap gap-2 border-t border-border/60 pt-2">
          <button
            type="button"
            className="rounded border border-input px-3 py-1.5 text-xs disabled:opacity-50"
            onClick={onReplace}
            disabled={busy}
            data-testid="nir1-typed-replace"
          >
            新しい Revision を準備
          </button>
        </div>
      )}
    </section>
  );
}
