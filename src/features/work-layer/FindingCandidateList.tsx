import type { WorkLayerCandidateView } from "./types";

interface FindingCandidateListProps {
  readonly candidates: readonly WorkLayerCandidateView[];
  readonly findingId: string;
  readonly onSelect: (candidateId: string) => void;
  readonly selectedCandidateId: string;
}

export function FindingCandidateList({
  candidates,
  findingId,
  onSelect,
  selectedCandidateId,
}: FindingCandidateListProps) {
  return (
    <div className="mt-4 space-y-1">
      <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
        CANDIDATES
      </div>
      {candidates.map((candidate) => (
        <label
          key={candidate.id}
          className="flex cursor-pointer items-center rounded-sm border border-border px-3 py-2 text-xs hover:bg-accent focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1"
        >
          <input
            type="radio"
            name={`work-layer-candidate-${findingId}`}
            aria-label={candidate.label}
            checked={selectedCandidateId === candidate.id}
            onChange={() => onSelect(candidate.id)}
            className="sr-only"
          />
          <span
            className="mr-2 h-3 w-3 rounded-full border border-foreground/50"
            aria-hidden="true"
          >
            {selectedCandidateId === candidate.id && (
              <span className="m-[2px] block h-[6px] w-[6px] rounded-full bg-foreground" />
            )}
          </span>
          <span className="font-medium">{candidate.label}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {candidate.meta}
          </span>
        </label>
      ))}
    </div>
  );
}
