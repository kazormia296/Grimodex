import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type {
  CodexEntityHypothesis,
  CodexEntityHypothesisPayload,
  EntityClusterManifestEntry,
} from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { CoarseEntityClass } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import {
  filterKnownTypeRefs,
  resolveEntityType,
  type KnowledgeTypeCatalogRecord,
} from "@/features/codex/extraction/entityResolver";
import {
  matchExistingEntity,
  type ExistingEntityCatalogRecord,
} from "@/features/codex/extraction/existingEntityMatcher";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_ENTITY_RESOLVE_PATH =
  "narrative_entity_resolve" as const;

export interface EntityResolutionSourceView {
  readonly sourceRef: string;
  readonly text: string;
}

export interface EntityResolutionCatalogForAi {
  /** Opaque type catalog rows — sourceKey must NOT be included in the prompt. */
  readonly types: readonly Pick<
    KnowledgeTypeCatalogRecord,
    "ref" | "slug" | "label" | "description" | "coarseClassHints"
  >[];
  /** Opaque existing entry rows — sourceKey / DB ids must NOT be included. */
  readonly existingEntries: readonly {
    readonly ref: string;
    readonly name: string;
    readonly aliases: readonly string[];
    readonly typeRef: string;
  }[];
}

export interface RunEntityResolutionTaskInput {
  readonly cluster: EntityClusterManifestEntry;
  readonly surfaces: readonly string[];
  readonly sourceViews: readonly EntityResolutionSourceView[];
  readonly catalog: EntityResolutionCatalogForAi;
  /** Full local catalogs (include sourceKey) for post-AI validation only. */
  readonly typeCatalog: readonly KnowledgeTypeCatalogRecord[];
  readonly existingCatalog: readonly ExistingEntityCatalogRecord[];
  readonly projectId?: string | null;
  readonly createId?: () => string;
  readonly repairOnFailure?: boolean;
}

const COARSE_CLASSES: readonly CoarseEntityClass[] = [
  "person",
  "place",
  "organization",
  "item",
  "concept",
  "other",
  "unknown",
];

function buildEntityResolutionPrompt(
  input: RunEntityResolutionTaskInput,
): string {
  const sources = input.sourceViews
    .map((view) => `--- sourceRef=${view.sourceRef} ---\n${view.text}`)
    .join("\n\n");
  const types = input.catalog.types
    .map(
      (type) =>
        `- ${type.ref}: slug=${type.slug}; label=${type.label}; coarse=[${type.coarseClassHints.join(",")}]${type.description ? `; desc=${type.description}` : ""}`,
    )
    .join("\n");
  const entries = input.catalog.existingEntries
    .map(
      (entry) =>
        `- ${entry.ref}: name=${entry.name}; aliases=[${entry.aliases.join(",")}]; typeRef=${entry.typeRef}`,
    )
    .join("\n");
  return `あなたは小説の Entity 同定アシスタントです。Cluster 内の呼称を評価し、既存 Entry への照合と Type 解決を JSON で返してください。
Project ID / Scene ID / Codex Entry の実 DB ID は入力にも出力にも使いません。
Type は typeCatalog の不透明 Ref（T0001…）だけ、既存 Entry は entryCatalog の不透明 Ref（K0001…）だけを使います。
Source View の sourceRef（S0001…）以外の文書 ID は使いません。

# clusterId
${input.cluster.clusterId}

# surfaces
${input.surfaces.map((surface) => `- ${surface}`).join("\n")}

# Source Views
${sources}

# typeCatalog
${types || "(empty)"}

# entryCatalog
${entries || "(empty)"}

# 出力（JSON のみ）
{"clusterId":"${input.cluster.clusterId}","canonicalName":"表示名","coarseClass":"person","suggestedTypeRefs":["T0001"],"summarySuggestion":"一文要約または null","explicitIdentityRefs":[]}`;
}

interface RawEntityResolutionAiResult {
  readonly canonicalName: string;
  readonly coarseClass: CoarseEntityClass;
  readonly suggestedTypeRefs: readonly string[];
  readonly summarySuggestion: string | null;
  readonly explicitIdentityRefs: readonly string[];
}

function parseEntityResolutionAiResult(
  responseText: string,
  clusterId: string,
): RawEntityResolutionAiResult | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.clusterId === "string" && record.clusterId !== clusterId) {
    return null;
  }
  if (
    typeof record.canonicalName !== "string" ||
    record.canonicalName.trim().length === 0
  ) {
    return null;
  }
  const coarseClass = COARSE_CLASSES.includes(
    record.coarseClass as CoarseEntityClass,
  )
    ? (record.coarseClass as CoarseEntityClass)
    : "unknown";
  const suggestedTypeRefs = Array.isArray(record.suggestedTypeRefs)
    ? record.suggestedTypeRefs.filter(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      )
    : [];
  const explicitIdentityRefs = Array.isArray(record.explicitIdentityRefs)
    ? record.explicitIdentityRefs.filter(
        (ref): ref is string => typeof ref === "string" && ref.length > 0,
      )
    : [];
  const summarySuggestion =
    record.summarySuggestion === null
      ? null
      : typeof record.summarySuggestion === "string"
        ? record.summarySuggestion
        : null;
  return {
    canonicalName: record.canonicalName.trim(),
    coarseClass,
    suggestedTypeRefs,
    summarySuggestion,
    explicitIdentityRefs,
  };
}

function buildHypothesis(
  input: RunEntityResolutionTaskInput,
  ai: RawEntityResolutionAiResult,
  createId: () => string,
): CodexEntityHypothesis {
  const knownTypeRefs = filterKnownTypeRefs(
    ai.suggestedTypeRefs,
    input.typeCatalog,
  );
  const knownExplicitRefs = ai.explicitIdentityRefs.filter((ref) =>
    input.existingCatalog.some((entry) => entry.ref === ref),
  );
  const existingResolution = matchExistingEntity(
    {
      surfaces: [ai.canonicalName, ...input.surfaces],
      explicitIdentityRefs: knownExplicitRefs,
    },
    input.existingCatalog,
  );
  const typeResolution = resolveEntityType({
    existingResolution,
    existingCatalog: input.existingCatalog,
    typeCatalog: input.typeCatalog,
    suggestedTypeRefs: knownTypeRefs,
    coarseClass: ai.coarseClass,
  });

  const payload: CodexEntityHypothesisPayload = {
    entityId: createId(),
    canonicalName: ai.canonicalName,
    mentionSurfaces: input.surfaces.map((surface) => ({
      surface,
      form: "proper-name" as const,
      observationIds: [...input.cluster.mentionObservationIds],
    })),
    aliases: [],
    coarseClass: ai.coarseClass,
    typeResolution,
    existingResolution,
    summarySuggestion: ai.summarySuggestion,
  };

  return {
    hypothesisId: createId(),
    clusterRef: input.cluster.clusterId,
    payload,
  };
}

/**
 * Stage AI: narrative_entity_resolve.
 * Passes ONLY opaque catalog refs (T#### / K####) and Source View refs (S####).
 * Never sends real DB entry IDs.
 */
export async function runEntityResolutionTask(
  input: RunEntityResolutionTaskInput,
): Promise<CodexEntityHypothesis | null> {
  if (blockIfPolicyOff("analysis")) return null;
  if (input.surfaces.length === 0 && input.sourceViews.length === 0) {
    return null;
  }

  // Fail closed: ensure caller-facing catalog never embeds sourceKey.
  for (const type of input.catalog.types) {
    if ("sourceKey" in type) {
      throw new Error(
        "narrative_entity_resolve catalog.types must not include sourceKey",
      );
    }
  }
  for (const entry of input.catalog.existingEntries) {
    if ("sourceKey" in entry || "id" in entry) {
      throw new Error(
        "narrative_entity_resolve catalog.existingEntries must be opaque refs only",
      );
    }
  }

  const prompt = buildEntityResolutionPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_entity_resolve");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_entity_resolve",
    },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: "narrative_entity_resolve",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_ENTITY_RESOLVE_PATH },
  });

  const createId = input.createId ?? (() => crypto.randomUUID());
  const first = parseEntityResolutionAiResult(
    response.text,
    input.cluster.clusterId,
  );
  if (first) return buildHypothesis(input, first, createId);
  if (input.repairOnFailure === false) return null;

  const repaired = await runStructuredRepairTask({
    brokenText: response.text,
    expectedShape: `{"clusterId":"${input.cluster.clusterId}","canonicalName":"name","coarseClass":"person","suggestedTypeRefs":["T0001"],"summarySuggestion":null,"explicitIdentityRefs":[]}`,
    projectId,
  });
  if (!repaired) return null;
  const second = parseEntityResolutionAiResult(
    repaired,
    input.cluster.clusterId,
  );
  return second ? buildHypothesis(input, second, createId) : null;
}
