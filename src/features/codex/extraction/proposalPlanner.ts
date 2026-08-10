import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityMentionForm } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import {
  bindExistingCodexEntityProposal,
  createNewBindCodexEntityProposal,
  unresolvedBindCodexEntityProposal,
  type AliasCandidate,
  type BindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";

/** Mention forms that may become a new Codex Entry name (spec §9). */
const NAMEABLE_MENTION_FORMS: ReadonlySet<EntityMentionForm> = new Set([
  "proper-name",
  "alias",
  "title",
  "description",
]);

export interface PlanBindCodexEntityProposalsInput {
  readonly hypotheses: readonly CodexEntityHypothesis[];
  readonly createId?: () => string;
  /**
   * When true (default), type unresolved / ambiguous create-new proposals are
   * still emitted but marked blocked via planner metadata.
   */
  readonly emitBlocked?: boolean;
}

export interface PlannedBindCodexEntityProposal {
  readonly proposal: BindCodexEntityProposal;
  readonly hypothesisId: string;
  /** Type unresolved/ambiguous blocks apply until the user resolves Type. */
  readonly blocked: boolean;
  readonly blockedReason?: string;
}

function explicitAliases(
  hypothesis: CodexEntityHypothesis,
): AliasCandidate[] {
  return hypothesis.payload.aliases
    .filter((alias) => alias.status === "explicit")
    .map((alias) => ({
      surface: alias.surface,
      status: "explicit" as const,
    }));
}

function hasNameableMention(hypothesis: CodexEntityHypothesis): boolean {
  return hypothesis.payload.mentionSurfaces.some((mention) =>
    NAMEABLE_MENTION_FORMS.has(mention.form),
  );
}

function hasProperNameMention(hypothesis: CodexEntityHypothesis): boolean {
  return hypothesis.payload.mentionSurfaces.some(
    (mention) => mention.form === "proper-name",
  );
}

function isPronounOnly(hypothesis: CodexEntityHypothesis): boolean {
  const forms = hypothesis.payload.mentionSurfaces;
  if (forms.length === 0) return true;
  return forms.every(
    (mention) =>
      mention.form === "pronoun" || mention.form === "implicit",
  );
}

function typeBlockedReason(
  hypothesis: CodexEntityHypothesis,
): string | undefined {
  const resolution = hypothesis.payload.typeResolution;
  if (resolution.status === "unresolved") {
    return "Codex Type が未解決です";
  }
  if (resolution.status === "ambiguous") {
    return "Codex Type が曖昧です";
  }
  return undefined;
}

/**
 * Gate Entity Hypotheses into BindCodexEntityProposal rows.
 *
 * Rules (spec §2 / §9 / §10 / §14):
 * - pronoun/implicit-only clusters never create-new
 * - aliasesToAdd / payload.aliases only include explicit identity aliases
 * - existing enrichment summary is fill-if-empty only (never overwrite)
 * - type unresolved → blocked (still emitted for review)
 */
export function planBindCodexEntityProposals(
  input: PlanBindCodexEntityProposalsInput,
): readonly PlannedBindCodexEntityProposal[] {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const emitBlocked = input.emitBlocked ?? true;
  const planned: PlannedBindCodexEntityProposal[] = [];

  for (const hypothesis of input.hypotheses) {
    const aliases = explicitAliases(hypothesis);
    const aliasSurfaces = aliases.map((alias) => alias.surface);
    const typeResolution = hypothesis.payload.typeResolution;
    const typeReason = typeBlockedReason(hypothesis);
    const blocked = typeReason !== undefined;
    if (blocked && !emitBlocked) continue;

    const basePayload = {
      narrativeEntityId: hypothesis.payload.entityId,
      canonicalName: hypothesis.payload.canonicalName,
      aliases,
      coarseClass: hypothesis.payload.coarseClass,
      typeResolution,
    };

    const existing = hypothesis.payload.existingResolution;

    if (existing.status === "resolved") {
      const summarySuggestion = hypothesis.payload.summarySuggestion?.trim();
      planned.push({
        hypothesisId: hypothesis.hypothesisId,
        // Existing Entry keeps its type; Type gate applies only to create-new.
        blocked: false,
        proposal: bindExistingCodexEntityProposal(
          {
            ...basePayload,
            binding: {
              kind: "bind-existing",
              entityRef: existing.ref,
              enrichment: {
                aliasesToAdd: aliasSurfaces,
                summary:
                  summarySuggestion && summarySuggestion.length > 0
                    ? { kind: "fill-if-empty", value: summarySuggestion }
                    : { kind: "leave" },
              },
            },
          },
          { createId },
        ),
      });
      continue;
    }

    if (existing.status === "ambiguous") {
      const allowCreateNew =
        hasNameableMention(hypothesis) && !isPronounOnly(hypothesis);
      planned.push({
        hypothesisId: hypothesis.hypothesisId,
        blocked: true,
        blockedReason: "既存 Entry 候補が複数あり、Binding が未解決です",
        proposal: unresolvedBindCodexEntityProposal(
          {
            ...basePayload,
            binding: {
              kind: "unresolved",
              candidates: existing.candidates,
              allowCreateNew,
            },
          },
          { createId },
        ),
      });
      continue;
    }

    // existing.status === "none"
    if (isPronounOnly(hypothesis) || !hasNameableMention(hypothesis)) {
      // No durable name surface → do not emit create-new.
      continue;
    }

    planned.push({
      hypothesisId: hypothesis.hypothesisId,
      blocked,
      blockedReason: typeReason,
      proposal: createNewBindCodexEntityProposal(
        {
          ...basePayload,
          binding: {
            kind: "create-new",
            entry: {
              name: hypothesis.payload.canonicalName,
              aliases: aliasSurfaces,
              summary: hypothesis.payload.summarySuggestion,
            },
          },
        },
        { createId },
      ),
    });
  }

  return planned;
}

export function hypothesisHasExplicitProperName(
  hypothesis: CodexEntityHypothesis,
): boolean {
  return hasProperNameMention(hypothesis);
}
