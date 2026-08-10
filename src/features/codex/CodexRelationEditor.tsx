import type { CodexRelationReviewProposal } from "./codexStructureExtractionStore";

export interface CodexRelationEditorProps {
  readonly proposal: CodexRelationReviewProposal;
  readonly onChange: (patch: {
    directionality?: "directed" | "symmetric";
    forwardLabel?: string;
    inverseLabel?: string | null;
  }) => void;
  readonly disabled?: boolean;
}

/**
 * Directionality + label editor for a Relation proposal (spec §21 Relation Card).
 */
export function CodexRelationEditor({
  proposal,
  onChange,
  disabled = false,
}: CodexRelationEditorProps) {
  const relation = proposal.proposal.payload.relation;
  const symmetric = relation.directionality === "symmetric";

  return (
    <div
      className="flex flex-col gap-2 rounded border border-border px-2 py-2"
      data-testid="codex-relation-editor"
    >
      <span className="text-xs font-medium text-foreground">Relation 編集</span>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <span className="text-muted-foreground">Subject</span>
          <p className="truncate font-medium">{proposal.subjectLabel}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Object</span>
          <p className="truncate font-medium">{proposal.objectLabel}</p>
        </div>
      </div>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Directionality</span>
        <select
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={relation.directionality}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              directionality: event.target.value as "directed" | "symmetric",
            })
          }
          data-testid="codex-relation-directionality"
        >
          <option value="directed">directed</option>
          <option value="symmetric">symmetric</option>
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Forward Label</span>
        <input
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={relation.forwardLabel}
          disabled={disabled}
          onChange={(event) => onChange({ forwardLabel: event.target.value })}
          data-testid="codex-relation-forward-label"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Inverse Label</span>
        <input
          className="rounded border border-input bg-background px-2 py-1 text-sm disabled:opacity-50"
          value={
            symmetric
              ? relation.forwardLabel
              : (relation.inverseLabel ?? "")
          }
          disabled={disabled || symmetric}
          onChange={(event) =>
            onChange({
              inverseLabel: event.target.value.trim() || null,
            })
          }
          data-testid="codex-relation-inverse-label"
        />
      </label>

      <p className="text-[10px] text-muted-foreground">
        Validity: {proposal.proposal.payload.validity}
      </p>
    </div>
  );
}
