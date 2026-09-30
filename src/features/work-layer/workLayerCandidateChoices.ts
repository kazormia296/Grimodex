import type { WorkLayerCandidateView } from "./types";

export const NEW_PERSON_CANDIDATE_ID = "preview-new-person";

export function withNewPersonCandidate(
  candidates: readonly WorkLayerCandidateView[],
  label: string,
): readonly WorkLayerCandidateView[] {
  if (candidates.length === 0) return candidates;
  return [
    ...candidates,
    {
      id: NEW_PERSON_CANDIDATE_ID,
      label,
      meta: "NEW · PREVIEW",
    },
  ];
}
