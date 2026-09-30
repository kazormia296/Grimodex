import type { DetailDefinitionCatalogRecord } from "@/features/codex/details/detailDefinitionCatalog";
import type {
  PhaseDetailWrite,
  ProjectedDetailValue,
} from "@/features/codex/details/semanticBindingTypes";
import type { StateAssertionValue } from "@/features/narrative-extraction/ir/observations/stateAssertion";

export type DetailComposeErrorCode =
  | "dropdown-requires-option-ref"
  | "unknown-option-ref"
  | "value-kind-mismatch"
  | "empty-text"
  | "inherit-not-composable-to-value";

export class DetailComposeError extends Error {
  readonly code: DetailComposeErrorCode;

  constructor(code: DetailComposeErrorCode, message: string) {
    super(message);
    this.name = "DetailComposeError";
    this.code = code;
  }
}

export interface ComposeDetailValueInput {
  readonly definition: DetailDefinitionCatalogRecord;
  readonly assertionValue: StateAssertionValue;
  /** Allowed opaque option refs for dropdown definitions. */
  readonly optionRefs?: ReadonlySet<string>;
}

/**
 * Compose a ProjectedDetailValue from a StateAssertion value.
 *
 * Rules:
 * - dropdown → opaque optionRef only (never raw labels)
 * - clear stays clear (distinct from inherit / set)
 * - inherit is not a composable assertion value
 */
export function composeDetailValue(
  input: ComposeDetailValueInput,
): ProjectedDetailValue {
  const { definition, assertionValue } = input;

  if (assertionValue.kind === "clear") {
    return { kind: "clear" };
  }

  if (definition.fieldType === "dropdown") {
    if (assertionValue.kind !== "enum") {
      throw new DetailComposeError(
        "dropdown-requires-option-ref",
        "Dropdown Detail values must use opaque option refs",
      );
    }
    const optionRef = assertionValue.optionRef.trim();
    if (!optionRef) {
      throw new DetailComposeError(
        "dropdown-requires-option-ref",
        "Dropdown option ref must be non-empty",
      );
    }
    if (input.optionRefs && !input.optionRefs.has(optionRef)) {
      throw new DetailComposeError(
        "unknown-option-ref",
        `Unknown dropdown option ref: ${optionRef}`,
      );
    }
    return { kind: "enum", optionRef };
  }

  if (assertionValue.kind === "enum") {
    throw new DetailComposeError(
      "value-kind-mismatch",
      "Enum assertion cannot bind to a non-dropdown Detail",
    );
  }

  if (assertionValue.kind === "entity") {
    return { kind: "entity", entityId: assertionValue.entityLocalId };
  }

  const text = assertionValue.text.trim();
  if (!text) {
    throw new DetailComposeError("empty-text", "Text Detail value is empty");
  }
  return { kind: "text", text };
}

/**
 * Preserve clear ≠ inherit ≠ set when lifting a composed value into a Phase write.
 */
export function toPhaseDetailWrite(
  kind: "set" | "clear" | "inherit",
  value: ProjectedDetailValue | null,
): PhaseDetailWrite {
  if (kind === "inherit") return { kind: "inherit" };
  if (kind === "clear") return { kind: "clear" };
  if (!value || value.kind === "clear") return { kind: "clear" };
  return { kind: "set", value };
}
