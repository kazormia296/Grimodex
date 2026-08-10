import type { DetailDefinitionCatalogRecord } from "./detailDefinitionCatalog";
import type {
  NarrativeEntityId,
  ProjectedDetailValue,
} from "./semanticBindingTypes";

export interface DetailEntityReferenceCodec {
  narrativeEntityIdForEntryId(entryId: string): NarrativeEntityId | null;
  entryIdForNarrativeEntityId(entityId: NarrativeEntityId): string | null;
}

export interface DetailValueCodecContext {
  readonly entityReferences?: DetailEntityReferenceCodec;
}

export type DetailValueCodecErrorCode =
  | "invalid-text-storage"
  | "unknown-option-ref"
  | "unknown-option-label"
  | "value-kind-mismatch"
  | "entity-reference-resolution-required"
  | "unresolved-entity-reference";

export class DetailValueCodecError extends Error {
  readonly code: DetailValueCodecErrorCode;

  constructor(code: DetailValueCodecErrorCode, message: string) {
    super(message);
    this.name = "DetailValueCodecError";
    this.code = code;
  }
}

export interface DetailValueCodec {
  decode(
    definition: DetailDefinitionCatalogRecord,
    storedValue: string | null,
    context?: DetailValueCodecContext,
  ): ProjectedDetailValue | null;
  encodeBase(
    definition: DetailDefinitionCatalogRecord,
    value: ProjectedDetailValue,
    context?: DetailValueCodecContext,
  ): string | null;
  encodePhaseOverride(
    definition: DetailDefinitionCatalogRecord,
    value: ProjectedDetailValue,
    context?: DetailValueCodecContext,
  ): string | null;
}

interface ProseMirrorNode {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
}

interface DecodedProseMirrorNode {
  readonly text: string;
  readonly isBlock: boolean;
}

const PROSEMIRROR_BLOCK_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "codeBlock",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "sceneBeat",
  "generatedProseBlock",
]);

function decodeProseMirrorNode(node: unknown): DecodedProseMirrorNode {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new DetailValueCodecError(
      "invalid-text-storage",
      "Stored ProseMirror Detail contains an invalid node",
    );
  }
  const candidate = node as ProseMirrorNode;
  if (candidate.type === "text") {
    if (typeof candidate.text !== "string") {
      throw new DetailValueCodecError(
        "invalid-text-storage",
        "Stored ProseMirror text node has no string text",
      );
    }
    return { text: candidate.text, isBlock: false };
  }
  if (candidate.type === "hardBreak") {
    return { text: "\n", isBlock: false };
  }
  const isBlock =
    typeof candidate.type === "string" &&
    PROSEMIRROR_BLOCK_TYPES.has(candidate.type);
  if (candidate.content === undefined) return { text: "", isBlock };
  if (!Array.isArray(candidate.content)) {
    throw new DetailValueCodecError(
      "invalid-text-storage",
      "Stored ProseMirror Detail has non-array content",
    );
  }
  const children = candidate.content.map(decodeProseMirrorNode);
  let text = "";
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const previous = children[index - 1];
    if (previous && (previous.isBlock || child.isBlock)) text += "\n";
    text += child.text;
  }
  return { text, isBlock };
}

function decodeProseMirrorDocument(parsed: object): string {
  const candidate = parsed as ProseMirrorNode;
  if (candidate.content === undefined) return "";
  if (!Array.isArray(candidate.content)) {
    throw new DetailValueCodecError(
      "invalid-text-storage",
      "Stored ProseMirror doc has non-array content",
    );
  }
  return decodeProseMirrorNode(parsed).text;
}

function decodeText(storedValue: string): ProjectedDetailValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedValue);
  } catch {
    return { kind: "text", text: storedValue };
  }

  if (typeof parsed !== "object" || parsed === null) {
    // JSON-looking scalars are valid legacy plain text and must remain exact.
    return { kind: "text", text: storedValue };
  }

  // Historical Codex editors used an empty object as the empty PM document
  // sentinel. Preserve that released storage contract without accepting other
  // malformed JSON objects as silently empty prose.
  if (!Array.isArray(parsed) && Object.keys(parsed).length === 0) {
    return { kind: "text", text: "" };
  }

  if (
    Array.isArray(parsed) ||
    !("type" in parsed) ||
    parsed.type !== "doc" ||
    ("content" in parsed &&
      parsed.content !== undefined &&
      !Array.isArray(parsed.content))
  ) {
    throw new DetailValueCodecError(
      "invalid-text-storage",
      "Stored text Detail is neither legacy plain text nor a ProseMirror doc",
    );
  }

  return { kind: "text", text: decodeProseMirrorDocument(parsed) };
}

function encodeText(text: string): string {
  const paragraph =
    text === ""
      ? { type: "paragraph" as const }
      : {
          type: "paragraph" as const,
          content: [{ type: "text" as const, text }],
        };
  return JSON.stringify({
    type: "doc",
    content: [paragraph],
  });
}

function requireEntityReferences(
  context: DetailValueCodecContext | undefined,
): DetailEntityReferenceCodec {
  if (!context?.entityReferences) {
    throw new DetailValueCodecError(
      "entity-reference-resolution-required",
      "An Entity Binding resolver is required for codex_reference Details",
    );
  }
  return context.entityReferences;
}

function decodeStoredValue(
  definition: DetailDefinitionCatalogRecord,
  storedValue: string | null,
  context?: DetailValueCodecContext,
): ProjectedDetailValue {
  // Row absence is represented by PhaseDetailWrite.inherit and never enters
  // this codec. A row whose stored value is NULL is an explicit clear.
  if (storedValue === null) return { kind: "clear" };

  switch (definition.fieldType) {
    case "text":
      return decodeText(storedValue);
    case "dropdown": {
      const option = definition.options.find(
        (candidate) => candidate.label === storedValue,
      );
      if (!option) {
        throw new DetailValueCodecError(
          "unknown-option-label",
          `Unknown dropdown option label for ${definition.definitionRef}`,
        );
      }
      return { kind: "enum", optionRef: option.optionRef };
    }
    case "codex_reference": {
      const entityId =
        requireEntityReferences(context).narrativeEntityIdForEntryId(
          storedValue,
        );
      if (typeof entityId !== "string" || entityId.length === 0) {
        throw new DetailValueCodecError(
          "unresolved-entity-reference",
          `No Narrative Entity Binding exists for the stored Codex Entry`,
        );
      }
      return { kind: "entity", entityId };
    }
  }
}

function encodeProjectedValue(
  definition: DetailDefinitionCatalogRecord,
  value: ProjectedDetailValue,
  context?: DetailValueCodecContext,
): string | null {
  if (value.kind === "clear") return null;

  switch (definition.fieldType) {
    case "text":
      if (value.kind !== "text") {
        throw new DetailValueCodecError(
          "value-kind-mismatch",
          "Projected value kind is incompatible with the text field type",
        );
      }
      return encodeText(value.text);
    case "dropdown": {
      if (value.kind !== "enum") {
        throw new DetailValueCodecError(
          "value-kind-mismatch",
          "Projected value kind is incompatible with the dropdown field type",
        );
      }
      const option = definition.options.find(
        (candidate) => candidate.optionRef === value.optionRef,
      );
      if (!option) {
        throw new DetailValueCodecError(
          "unknown-option-ref",
          `Unknown dropdown option ref for ${definition.definitionRef}`,
        );
      }
      return option.label;
    }
    case "codex_reference": {
      if (value.kind !== "entity") {
        throw new DetailValueCodecError(
          "value-kind-mismatch",
          "Projected value kind is incompatible with the codex_reference field type",
        );
      }
      const entryId = requireEntityReferences(
        context,
      ).entryIdForNarrativeEntityId(value.entityId);
      if (typeof entryId !== "string" || entryId.length === 0) {
        throw new DetailValueCodecError(
          "unresolved-entity-reference",
          "No Codex Entry Binding exists for the Narrative Entity",
        );
      }
      return entryId;
    }
  }
}

export const detailValueCodec: DetailValueCodec = Object.freeze({
  decode: decodeStoredValue,
  encodeBase: encodeProjectedValue,
  encodePhaseOverride: encodeProjectedValue,
});
