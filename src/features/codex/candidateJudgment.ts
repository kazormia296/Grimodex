/**
 * candidateJudgment.ts — RETIRED (Codex Vertical Slice PR6 Cutover).
 *
 * Product AI path `codex_judgment` no longer runs. Structure extraction uses
 * `narrative_entity_resolve` / `narrative_relation_synthesize` and Proposal
 * Review instead of sending real DB IDs / fixed 4 types / mergeTargetId.
 */
import i18next from "@/lib/i18n";
import type { CodexCandidate } from "./candidateExtractor";

export type SuggestedType = "character" | "location" | "item" | "lore";

export interface CandidateJudgment {
  surface: string;
  suggestedType: SuggestedType;
  summary: string;
  /** @deprecated Never populated after PR6 retirement. */
  aliasOfId: string | null;
}

export const CODEX_JUDGMENT_RETIRED = "CODEX_JUDGMENT_RETIRED" as const;

export class CandidateJudgmentRetiredError extends Error {
  readonly code = CODEX_JUDGMENT_RETIRED;

  constructor() {
    super(i18next.t("codex.candidates.judgeRetired", {
      defaultValue:
        "旧 Codex 候補判定は退役しました。構造抽出レビューを使ってください。",
    }));
    this.name = "CandidateJudgmentRetiredError";
  }
}

/** @deprecated Prefer CandidateJudgmentRetiredError. */
export const CODEX_JUDGMENT_NO_VALID_RESULT = CODEX_JUDGMENT_RETIRED;

/** @deprecated Prefer CandidateJudgmentRetiredError. */
export class CandidateJudgmentNoValidResultError extends CandidateJudgmentRetiredError {}

type EntryLike = { id: string; name: string | null; aliases: string | null };

/**
 * @deprecated Product path retired in PR6. Always rejects without calling the model.
 */
export async function judgeCandidates(
  _candidates: ReadonlyArray<CodexCandidate>,
  _entries: ReadonlyArray<EntryLike>,
): Promise<Map<string, CandidateJudgment>> {
  throw new CandidateJudgmentRetiredError();
}
