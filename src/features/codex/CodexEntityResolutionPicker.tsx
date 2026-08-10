import type { EntityBindingCandidate } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";

export interface CodexEntityResolutionPickerProps {
  readonly allowCreateNew: boolean;
  readonly candidates: readonly EntityBindingCandidate[];
  readonly candidateLabels?:
    | ReadonlyMap<string, string>
    | Record<string, string>;
  readonly onCreateNew?: () => void;
  readonly onUseExisting?: (entityRef: string) => void;
}

/**
 * Create-new / use-existing picker for unresolved Entity Binding.
 */
export function CodexEntityResolutionPicker({
  allowCreateNew,
  candidates,
  candidateLabels,
  onCreateNew,
  onUseExisting,
}: CodexEntityResolutionPickerProps) {
  const labelFor = (ref: string): string => {
    if (!candidateLabels) return ref;
    if (candidateLabels instanceof Map) return candidateLabels.get(ref) ?? ref;
    return candidateLabels[ref] ?? ref;
  };

  return (
    <div
      className="flex flex-col gap-2 rounded border border-border bg-muted/20 px-2.5 py-2"
      data-testid="codex-entity-resolution-picker"
    >
      <p className="text-xs font-medium text-foreground">Binding 解決</p>
      <div className="flex flex-wrap gap-1">
        {allowCreateNew && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-primary hover:bg-primary/10"
            onClick={onCreateNew}
            data-testid="codex-resolve-create-new"
          >
            新規作成
          </button>
        )}
      </div>
      {candidates.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {candidates.map((candidate) => (
            <li key={candidate.ref}>
              <button
                type="button"
                className="w-full rounded border border-border bg-background px-2 py-1 text-left text-[11px] hover:bg-accent/40"
                onClick={() => onUseExisting?.(candidate.ref)}
                data-testid={`codex-resolve-existing-${candidate.ref}`}
              >
                {labelFor(candidate.ref)}
                <span className="ml-1 text-muted-foreground">
                  ({candidate.ref}) · score {candidate.score}
                  {candidate.methods.length > 0
                    ? ` · ${candidate.methods.join(",")}`
                    : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-muted-foreground">既存候補はありません</p>
      )}
    </div>
  );
}
