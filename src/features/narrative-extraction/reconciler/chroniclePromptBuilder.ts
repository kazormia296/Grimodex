import { digestStableJson } from "../source/digest";
import type { Sha256Digest } from "../source/types";
import { validateDependencySelector } from "@/features/narrative-semantic-core/contracts/dependencyRole";
import {
  NARRATIVE_STAGE_IDS,
  type ChronicleNarrativeStageId,
} from "./stageExecution";
import type { ContextSetEntry } from "./types";

/** Version of the pure Chronicle prompt/request contract. */
export const CHRONICLE_PROMPT_CONTRACT_VERSION = 1 as const;
/** Versioned authority for dynamic model-visible Context Set declarations. */
export const CHRONICLE_CONTEXT_SET_VERSION = "chronicle.context-set/1" as const;

export interface ChroniclePromptComponentContract {
  readonly contractId: string;
  readonly contractVersion: string;
  /** Static task instruction; dynamic source text belongs in the Context Set. */
  readonly instruction: string;
  /** Static parser/output contract; dynamic source text must not be interpolated. */
  readonly outputShape: string;
}

export interface ChroniclePromptModelInput {
  /** Must point at exactly one model-visible Context Set entry. */
  readonly contextId: string;
  readonly value: string;
}

export interface ChroniclePromptBuilderInput {
  readonly stageId: ChronicleNarrativeStageId;
  readonly componentContract: ChroniclePromptComponentContract;
  readonly contextSet: readonly ContextSetEntry[];
  readonly modelInputs: readonly ChroniclePromptModelInput[];
}

export interface ChroniclePromptArtifact {
  readonly schemaVersion: typeof CHRONICLE_PROMPT_CONTRACT_VERSION;
  readonly contextSetVersion: typeof CHRONICLE_CONTEXT_SET_VERSION;
  readonly stageId: ChronicleNarrativeStageId;
  readonly componentContract: ChroniclePromptComponentContract;
  /** Canonically ordered declarations; values are intentionally not retained. */
  readonly contextSet: readonly ContextSetEntry[];
  readonly messages: readonly [
    { readonly role: "user"; readonly content: string },
  ];
}

export interface ChroniclePromptDigests {
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
}

const CONTEXT_EXPOSURES = new Set<ContextSetEntry["exposure"]>([
  "model-visible",
  "deterministic-stage",
  "author-supplied",
]);

function assertNonEmptyString(
  name: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function contextSortKey(entry: ContextSetEntry): string {
  return [entry.contextId, entry.inputRef, entry.stageId, entry.exposure].join(
    "\u0000",
  );
}

function compareCodeUnitStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalizeChronicleContextSet(
  contextSet: readonly ContextSetEntry[],
  expectedStageId?: string,
): readonly ContextSetEntry[] {
  const seenContextIds = new Set<string>();
  const seenInputRefs = new Set<string>();
  for (const entry of contextSet) {
    assertNonEmptyString("Context Set contextId", entry.contextId);
    assertNonEmptyString("Context Set inputRef", entry.inputRef);
    assertNonEmptyString("Context Set stageId", entry.stageId);
    if (expectedStageId !== undefined && entry.stageId !== expectedStageId) {
      throw new TypeError(
        `Context Set entry ${entry.contextId} belongs to ${entry.stageId}, expected ${expectedStageId}`,
      );
    }
    if (!CONTEXT_EXPOSURES.has(entry.exposure)) {
      throw new TypeError(
        `Unsupported Context Set exposure for ${entry.contextId}`,
      );
    }
    const selectorResult = validateDependencySelector(entry.selector);
    if (!selectorResult.valid) {
      throw new TypeError(
        `Invalid Context Set selector for ${entry.contextId}: ${selectorResult.error.code}`,
      );
    }
    if (seenContextIds.has(entry.contextId)) {
      throw new TypeError(
        `Duplicate Context Set contextId: ${entry.contextId}`,
      );
    }
    if (seenInputRefs.has(entry.inputRef)) {
      throw new TypeError(`Duplicate Context Set inputRef: ${entry.inputRef}`);
    }
    seenContextIds.add(entry.contextId);
    seenInputRefs.add(entry.inputRef);
  }
  return [...contextSet].sort((left, right) =>
    compareCodeUnitStrings(contextSortKey(left), contextSortKey(right)),
  );
}

export async function digestChronicleContextSet(
  contextSet: readonly ContextSetEntry[],
  expectedStageId?: string,
): Promise<Sha256Digest> {
  const canonicalContextSet = canonicalizeChronicleContextSet(
    contextSet,
    expectedStageId,
  );
  return digestStableJson({
    version: CHRONICLE_CONTEXT_SET_VERSION,
    entries: canonicalContextSet,
  });
}

function assertComponentContract(
  contract: ChroniclePromptComponentContract,
): void {
  assertNonEmptyString("componentContract.contractId", contract.contractId);
  assertNonEmptyString(
    "componentContract.contractVersion",
    contract.contractVersion,
  );
  assertNonEmptyString("componentContract.instruction", contract.instruction);
  assertNonEmptyString("componentContract.outputShape", contract.outputShape);
}

function buildModelInputMap(
  contextSet: readonly ContextSetEntry[],
  modelInputs: readonly ChroniclePromptModelInput[],
): ReadonlyMap<string, string> {
  const entriesById = new Map(
    contextSet.map((entry) => [entry.contextId, entry]),
  );
  const values = new Map<string, string>();
  for (const input of modelInputs) {
    assertNonEmptyString("model input contextId", input.contextId);
    if (values.has(input.contextId)) {
      throw new TypeError(
        `Duplicate model input contextId: ${input.contextId}`,
      );
    }
    const entry = entriesById.get(input.contextId);
    if (!entry) {
      throw new TypeError(
        `Model input is not declared in the Context Set: ${input.contextId}`,
      );
    }
    if (entry.exposure !== "model-visible") {
      throw new TypeError(
        `Model input ${input.contextId} is not model-visible in the Context Set`,
      );
    }
    if (typeof input.value !== "string") {
      throw new TypeError(
        `Model input value must be a string: ${input.contextId}`,
      );
    }
    values.set(input.contextId, input.value);
  }

  for (const entry of contextSet) {
    if (entry.exposure === "model-visible" && !values.has(entry.contextId)) {
      throw new TypeError(
        `model-visible Context Set entry has no model input: ${entry.contextId}`,
      );
    }
  }
  return values;
}

function renderModelContext(
  contextSet: readonly ContextSetEntry[],
  modelInputs: ReadonlyMap<string, string>,
): string {
  const sections = contextSet
    .filter((entry) => entry.exposure === "model-visible")
    .map((entry) => {
      const value = modelInputs.get(entry.contextId);
      if (value === undefined) {
        throw new TypeError(
          `model-visible Context Set entry has no model input: ${entry.contextId}`,
        );
      }
      return `--- contextId=${entry.contextId} inputRef=${entry.inputRef} ---\n${value}`;
    });
  return sections.length > 0
    ? sections.join("\n\n")
    : "(no model-visible context)";
}

/**
 * Build the exact model request from a declared Context Set.
 *
 * The only dynamic strings accepted by this boundary are modelInputs whose
 * contextId resolves to a `model-visible` entry. Static instruction and output
 * shape are component-contract inputs and are kept separate from that set.
 */
export function buildChroniclePromptArtifact(
  input: ChroniclePromptBuilderInput,
): ChroniclePromptArtifact {
  if (!Object.values(NARRATIVE_STAGE_IDS).includes(input.stageId)) {
    throw new TypeError(`Unsupported Chronicle stage: ${input.stageId}`);
  }
  assertComponentContract(input.componentContract);
  const contextSet = canonicalizeChronicleContextSet(
    input.contextSet,
    input.stageId,
  );
  const modelInputs = buildModelInputMap(contextSet, input.modelInputs);
  const content = [
    input.componentContract.instruction,
    "",
    "# Context Set (chronicle.prompt/1)",
    renderModelContext(contextSet, modelInputs),
    "",
    "# Output (JSON only)",
    input.componentContract.outputShape,
  ].join("\n");

  return {
    schemaVersion: CHRONICLE_PROMPT_CONTRACT_VERSION,
    contextSetVersion: CHRONICLE_CONTEXT_SET_VERSION,
    stageId: input.stageId,
    componentContract: { ...input.componentContract },
    contextSet,
    messages: [{ role: "user", content }],
  };
}

/** Compute the three ADR 010/011 digest domains for an exact request. */
export async function buildChroniclePromptDigests(
  artifact: ChroniclePromptArtifact,
): Promise<ChroniclePromptDigests> {
  const contextSetDigest = await digestChronicleContextSet(
    artifact.contextSet,
    artifact.stageId,
  );
  const componentContractDigest = await digestStableJson({
    schemaVersion: artifact.schemaVersion,
    contextSetVersion: artifact.contextSetVersion,
    stageId: artifact.stageId,
    componentContract: artifact.componentContract,
  });
  const finalRequestDigest = await digestStableJson({
    schemaVersion: artifact.schemaVersion,
    contextSetVersion: artifact.contextSetVersion,
    stageId: artifact.stageId,
    contextSetDigest,
    componentContractDigest,
    messages: artifact.messages,
  });
  return {
    contextSetDigest,
    componentContractDigest,
    finalRequestDigest,
  };
}
