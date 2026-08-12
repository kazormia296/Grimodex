import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { getEditorExtensions } from "@/features/editor/extensions";
import { getFileBackedEditorExtensions } from "@/features/external-mount/fileBackedEditorExtensions";
import { hasLoneSurrogate } from "./digest";
import { freezeDeep } from "./immutability";
import type {
  CanonicalBlockSpan,
  CanonicalText,
  CanonicalTextDiagnostic,
  CanonicalTextSerializationResult,
  MappedProjectionSegment,
  ProjectionSegment,
  TextProjectionMap,
} from "./types";

interface ProseMirrorJsonNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: readonly unknown[];
  readonly content: readonly ProseMirrorJsonNode[];
}

interface MutableBlock {
  text: string;
  segments: MappedProjectionSegment[];
  descriptors: readonly MutableBlockDescriptor[];
  pmFrom: number;
  pmTo: number;
}

interface MutableBlockDescriptor {
  readonly key: number;
  readonly nodeType: string;
  readonly depth: number;
  readonly attrs?: Readonly<Record<string, string | number | boolean | null>>;
}

interface SerializationState {
  nextBlockKey: number;
  descriptors: MutableBlockDescriptor[];
}

type NodeContext = "root" | "block" | "inline";
export type PersistedProseMirrorSchema = "database" | "file-backed";

const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "sceneBeat",
]);
const CONTAINER_BLOCK_TYPES = new Set([
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "generatedProseBlock",
]);
const NON_EMPTY_CONTAINER_TYPES = new Set([
  "doc",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "table",
  "tableRow",
  "tableCell",
  "tableHeader",
  "generatedProseBlock",
]);
const EMPTY_BLOCK_ATOM_TYPES = new Set(["horizontalRule", "sceneBreak"]);
const BLOCK_OBJECT_REPLACEMENT_TYPES = new Set(["image"]);
const INLINE_ATOM_TYPES = new Set(["hardBreak", "ruby", "mention", "image"]);

let databaseSchema: Schema | undefined;
let fileBackedSchema: Schema | undefined;

function persistedSchema(kind: PersistedProseMirrorSchema): Schema {
  if (kind === "file-backed") {
    fileBackedSchema ??= getSchema(getFileBackedEditorExtensions());
    return fileBackedSchema;
  }
  databaseSchema ??= getSchema(
    getEditorExtensions({ setMentionPopup: () => {} }),
  );
  return databaseSchema;
}

function normalizeWithPersistedSchema(
  parsed: unknown,
  schemaKind: PersistedProseMirrorSchema,
):
  | { readonly ok: true; readonly document: unknown }
  | { readonly ok: false; readonly diagnostic: CanonicalTextDiagnostic } {
  try {
    const document = ProseMirrorNode.fromJSON(
      persistedSchema(schemaKind),
      parsed,
    );
    document.check();
    return { ok: true, document: document.toJSON() };
  } catch {
    return {
      ok: false,
      diagnostic: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        `Persisted ProseMirror content is invalid for the ${schemaKind} Scene schema`,
        "$root",
      ),
    };
  }
}

function isBlockNodeType(type: string): boolean {
  return (
    TEXT_BLOCK_TYPES.has(type) ||
    type === "blockquote" ||
    type === "bulletList" ||
    type === "orderedList" ||
    type === "taskList" ||
    type === "table" ||
    type === "generatedProseBlock" ||
    EMPTY_BLOCK_ATOM_TYPES.has(type)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(
  code: string,
  message: string,
  path?: string,
  nodeType?: string,
): CanonicalTextDiagnostic {
  return {
    code,
    message,
    ...(path ? { path } : {}),
    ...(nodeType ? { nodeType } : {}),
  };
}

function findInvalidUnicode(value: unknown, path = "$root"): string | null {
  if (typeof value === "string") {
    return hasLoneSurrogate(value) ? path : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const invalidPath = findInvalidUnicode(value[index], `${path}[${index}]`);
      if (invalidPath) return invalidPath;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    if (hasLoneSurrogate(key)) return `${path}.[key]`;
    const invalidPath = findInvalidUnicode(child, `${path}.${key}`);
    if (invalidPath) return invalidPath;
  }
  return null;
}

export function isCanonicalNodeTypeSupported(type: string): boolean {
  return (
    type === "doc" ||
    type === "text" ||
    TEXT_BLOCK_TYPES.has(type) ||
    CONTAINER_BLOCK_TYPES.has(type) ||
    EMPTY_BLOCK_ATOM_TYPES.has(type) ||
    INLINE_ATOM_TYPES.has(type)
  );
}

function validateMarks(
  marks: unknown,
  path: string,
): CanonicalTextDiagnostic | null {
  if (marks === undefined) return null;
  if (!Array.isArray(marks)) {
    return diagnostic(
      "CANONICAL_INVALID_PM_DOCUMENT",
      "ProseMirror marks must be an array",
      path,
    );
  }
  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const markPath = `${path}[${index}]`;
    if (!isRecord(mark) || typeof mark.type !== "string" || !mark.type) {
      return diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "ProseMirror marks must have a non-empty type",
        markPath,
      );
    }
    if (mark.attrs !== undefined && !isRecord(mark.attrs)) {
      return diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "ProseMirror mark attrs must be an object",
        `${markPath}.attrs`,
      );
    }
  }
  return null;
}

function childContextFor(nodeType: string): NodeContext {
  if (TEXT_BLOCK_TYPES.has(nodeType)) return "inline";
  return "block";
}

function childTypeIsAllowed(
  parentType: string,
  childType: string,
  childIndex: number,
): boolean {
  if (parentType === "doc") {
    return isBlockNodeType(childType);
  }
  if (TEXT_BLOCK_TYPES.has(parentType)) {
    return childType === "text" || INLINE_ATOM_TYPES.has(childType);
  }
  if (parentType === "bulletList" || parentType === "orderedList") {
    return childType === "listItem";
  }
  if (parentType === "taskList") return childType === "taskItem";
  if (parentType === "table") return childType === "tableRow";
  if (parentType === "tableRow") {
    return childType === "tableCell" || childType === "tableHeader";
  }
  if (parentType === "listItem" || parentType === "taskItem") {
    if (childIndex === 0) return childType === "paragraph";
    return isBlockNodeType(childType);
  }
  if (
    parentType === "blockquote" ||
    parentType === "tableCell" ||
    parentType === "tableHeader" ||
    parentType === "generatedProseBlock"
  ) {
    return isBlockNodeType(childType);
  }
  return false;
}

function validateNode(
  value: unknown,
  path: string,
  context: NodeContext,
): { node: ProseMirrorJsonNode } | { error: CanonicalTextDiagnostic } {
  if (!isRecord(value) || typeof value.type !== "string" || !value.type) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "ProseMirror nodes must have a non-empty type",
        path,
      ),
    };
  }

  const type = value.type;
  if (!isCanonicalNodeTypeSupported(type)) {
    return {
      error: diagnostic(
        "CANONICAL_UNKNOWN_PM_NODE",
        `Unsupported ProseMirror node type: ${type}`,
        path,
        type,
      ),
    };
  }

  const contextMatches =
    (context === "root" && type === "doc") ||
    (context === "block" &&
      (TEXT_BLOCK_TYPES.has(type) ||
        CONTAINER_BLOCK_TYPES.has(type) ||
        EMPTY_BLOCK_ATOM_TYPES.has(type))) ||
    (context === "inline" && (type === "text" || INLINE_ATOM_TYPES.has(type)));
  if (!contextMatches) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        `ProseMirror node ${type} is not valid in ${context} content`,
        path,
        type,
      ),
    };
  }

  if (value.attrs !== undefined && !isRecord(value.attrs)) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "ProseMirror node attrs must be an object",
        `${path}.attrs`,
        type,
      ),
    };
  }
  if (
    type === "heading" &&
    value.attrs?.level !== undefined &&
    (!Number.isInteger(value.attrs.level) ||
      (value.attrs.level as number) < 1 ||
      (value.attrs.level as number) > 6)
  ) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "Heading level must be an integer from 1 through 6",
        `${path}.attrs.level`,
        type,
      ),
    };
  }
  if (
    type === "orderedList" &&
    value.attrs?.start !== undefined &&
    (!Number.isInteger(value.attrs.start) || (value.attrs.start as number) < 1)
  ) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "Ordered-list start must be a positive integer",
        `${path}.attrs.start`,
        type,
      ),
    };
  }
  if (
    type === "taskItem" &&
    value.attrs?.checked !== undefined &&
    typeof value.attrs.checked !== "boolean"
  ) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "Task-item checked must be boolean",
        `${path}.attrs.checked`,
        type,
      ),
    };
  }
  const marksError = validateMarks(value.marks, `${path}.marks`);
  if (marksError) return { error: marksError };

  if (type === "text") {
    if (typeof value.text !== "string" || value.text.length === 0) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          "ProseMirror text nodes must contain non-empty text",
          `${path}.text`,
          type,
        ),
      };
    }
    if (value.content !== undefined) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          "ProseMirror text nodes cannot contain child nodes",
          `${path}.content`,
          type,
        ),
      };
    }
    return {
      node: {
        type,
        text: value.text,
        ...(isRecord(value.attrs) ? { attrs: value.attrs } : {}),
        ...(Array.isArray(value.marks) ? { marks: value.marks } : {}),
        content: [],
      },
    };
  }

  if (type === "ruby") {
    if (!isRecord(value.attrs) || typeof value.attrs.base !== "string") {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          "Ruby nodes must contain a string base attribute",
          `${path}.attrs.base`,
          type,
        ),
      };
    }
  }
  if (type === "mention") {
    const attrs = value.attrs;
    if (
      !isRecord(attrs) ||
      (typeof attrs.label !== "string" && typeof attrs.id !== "string")
    ) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          "Mention nodes must contain a string label or id attribute",
          `${path}.attrs`,
          type,
        ),
      };
    }
  }

  const isLeaf =
    INLINE_ATOM_TYPES.has(type) || EMPTY_BLOCK_ATOM_TYPES.has(type);
  if (isLeaf) {
    if (value.content !== undefined && !Array.isArray(value.content)) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          "ProseMirror node content must be an array",
          `${path}.content`,
          type,
        ),
      };
    }
    if (Array.isArray(value.content) && value.content.length > 0) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          `Atomic ProseMirror node ${type} cannot contain child nodes`,
          `${path}.content`,
          type,
        ),
      };
    }
    return {
      node: {
        type,
        ...(isRecord(value.attrs) ? { attrs: value.attrs } : {}),
        ...(Array.isArray(value.marks) ? { marks: value.marks } : {}),
        content: [],
      },
    };
  }

  const rawContent = value.content ?? [];
  if (!Array.isArray(rawContent)) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        "ProseMirror node content must be an array",
        `${path}.content`,
        type,
      ),
    };
  }
  if (NON_EMPTY_CONTAINER_TYPES.has(type) && rawContent.length === 0) {
    return {
      error: diagnostic(
        "CANONICAL_INVALID_PM_DOCUMENT",
        `ProseMirror node ${type} requires child content`,
        `${path}.content`,
        type,
      ),
    };
  }

  const content: ProseMirrorJsonNode[] = [];
  const childContext = childContextFor(type);
  for (let index = 0; index < rawContent.length; index += 1) {
    const childValue = rawContent[index];
    if (
      isRecord(childValue) &&
      typeof childValue.type === "string" &&
      isCanonicalNodeTypeSupported(childValue.type) &&
      !childTypeIsAllowed(type, childValue.type, index)
    ) {
      return {
        error: diagnostic(
          "CANONICAL_INVALID_PM_DOCUMENT",
          `ProseMirror node ${childValue.type} is not valid inside ${type}`,
          `${path}.content[${index}]`,
          childValue.type,
        ),
      };
    }
    const child = validateNode(
      childValue,
      `${path}.content[${index}]`,
      childContext,
    );
    if ("error" in child) return child;
    content.push(child.node);
  }

  return {
    node: {
      type,
      ...(isRecord(value.attrs) ? { attrs: value.attrs } : {}),
      ...(Array.isArray(value.marks) ? { marks: value.marks } : {}),
      content,
    },
  };
}

function appendSegment(
  block: MutableBlock,
  segment: MappedProjectionSegment,
): void {
  const previous = block.segments.at(-1);
  if (
    previous?.kind === "linear" &&
    segment.kind === "linear" &&
    previous.canonicalEnd === segment.canonicalStart &&
    previous.to === segment.from
  ) {
    block.segments[block.segments.length - 1] = {
      ...previous,
      canonicalEnd: segment.canonicalEnd,
      to: segment.to,
      canonical: {
        from: previous.canonical.from,
        to: segment.canonical.to,
      },
      source: {
        kind: "prosemirror",
        fromPos: previous.source.fromPos,
        toPos: segment.source.toPos,
      },
    };
    return;
  }
  block.segments.push(segment);
}

function appendLinearText(
  block: MutableBlock,
  value: string,
  pmStart: number,
): void {
  let sourceOffset = 0;
  let plainStart = 0;

  const appendPlainSlice = (end: number): void => {
    if (end <= plainStart) return;
    const slice = value.slice(plainStart, end);
    const canonicalStart = block.text.length;
    block.text += slice;
    appendSegment(block, {
      canonicalStart,
      canonicalEnd: block.text.length,
      from: pmStart + plainStart,
      to: pmStart + end,
      kind: "linear",
      canonical: { from: canonicalStart, to: block.text.length },
      source: {
        kind: "prosemirror",
        fromPos: pmStart + plainStart,
        toPos: pmStart + end,
      },
    });
  };

  while (sourceOffset < value.length) {
    if (value.charCodeAt(sourceOffset) !== 0x0d) {
      sourceOffset += 1;
      continue;
    }

    appendPlainSlice(sourceOffset);
    const sourceLength = value.charCodeAt(sourceOffset + 1) === 0x0a ? 2 : 1;
    const canonicalStart = block.text.length;
    block.text += "\n";
    appendSegment(block, {
      canonicalStart,
      canonicalEnd: canonicalStart + 1,
      from: pmStart + sourceOffset,
      to: pmStart + sourceOffset + sourceLength,
      kind: "transformed",
      canonical: { from: canonicalStart, to: canonicalStart + 1 },
      source: {
        kind: "prosemirror",
        fromPos: pmStart + sourceOffset,
        toPos: pmStart + sourceOffset + sourceLength,
      },
      transform: sourceLength === 2 ? "crlf-to-lf" : "cr-to-lf",
    });
    sourceOffset += sourceLength;
    plainStart = sourceOffset;
  }
  appendPlainSlice(value.length);
}

function appendAtomicText(
  block: MutableBlock,
  value: string,
  from: number,
  to: number,
  nodeType: string,
): void {
  const normalized = value.replace(/\r\n?/gu, "\n");
  if (normalized.length === 0) return;
  const canonicalStart = block.text.length;
  block.text += normalized;
  appendSegment(block, {
    canonicalStart,
    canonicalEnd: block.text.length,
    from,
    to,
    kind: "atomic",
    canonical: { from: canonicalStart, to: block.text.length },
    source: { kind: "prosemirror", fromPos: from, toPos: to },
    nodeType,
  });
}

function nodeSize(node: ProseMirrorJsonNode): number {
  if (node.type === "text") return node.text?.length ?? 0;
  if (
    INLINE_ATOM_TYPES.has(node.type) ||
    EMPTY_BLOCK_ATOM_TYPES.has(node.type)
  ) {
    return 1;
  }
  return 2 + node.content.reduce((total, child) => total + nodeSize(child), 0);
}

function structuralAttrs(
  node: ProseMirrorJsonNode,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  const attrs: Record<string, string | number | boolean | null> = {};
  if (node.type === "heading" && typeof node.attrs?.level === "number") {
    attrs.level = node.attrs.level;
  }
  if (node.type === "orderedList" && typeof node.attrs?.start === "number") {
    attrs.start = node.attrs.start;
  }
  if (node.type === "taskItem" && typeof node.attrs?.checked === "boolean") {
    attrs.checked = node.attrs.checked;
  }
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function createBlockDescriptor(
  node: ProseMirrorJsonNode,
  depth: number,
  state: SerializationState,
): MutableBlockDescriptor {
  const descriptor: MutableBlockDescriptor = {
    key: state.nextBlockKey,
    nodeType: node.type,
    depth,
    ...(structuralAttrs(node) ? { attrs: structuralAttrs(node) } : {}),
  };
  state.nextBlockKey += 1;
  state.descriptors.push(descriptor);
  return descriptor;
}

function serializeTextBlock(
  node: ProseMirrorJsonNode,
  nodePosition: number,
  descriptors: readonly MutableBlockDescriptor[],
): MutableBlock {
  const block: MutableBlock = {
    text: "",
    segments: [],
    descriptors,
    pmFrom: nodePosition + 1,
    pmTo: nodePosition + nodeSize(node) - 1,
  };
  let childOffset = 0;

  for (const child of node.content) {
    const childPosition = nodePosition + 1 + childOffset;
    if (child.type === "text") {
      appendLinearText(block, child.text ?? "", childPosition);
    } else if (child.type === "hardBreak") {
      appendAtomicText(
        block,
        "\n",
        childPosition,
        childPosition + 1,
        child.type,
      );
    } else if (child.type === "ruby") {
      appendAtomicText(
        block,
        (child.attrs?.base as string | undefined) ?? "",
        childPosition,
        childPosition + 1,
        child.type,
      );
    } else if (child.type === "mention") {
      const label =
        (child.attrs?.label as string | undefined) ??
        (child.attrs?.id as string | undefined) ??
        "";
      appendAtomicText(
        block,
        `@${label}`,
        childPosition,
        childPosition + 1,
        child.type,
      );
    } else if (child.type === "image") {
      appendAtomicText(
        block,
        "\uFFFC",
        childPosition,
        childPosition + 1,
        child.type,
      );
    }
    childOffset += nodeSize(child);
  }
  return block;
}

function collectBlocks(
  node: ProseMirrorJsonNode,
  nodePosition: number,
  depth: number,
  ancestors: readonly MutableBlockDescriptor[],
  state: SerializationState,
): MutableBlock[] {
  if (node.type === "doc") {
    const blocks: MutableBlock[] = [];
    let childOffset = 0;
    for (const child of node.content) {
      blocks.push(...collectBlocks(child, childOffset, 0, [], state));
      childOffset += nodeSize(child);
    }
    return blocks;
  }

  const descriptor = createBlockDescriptor(node, depth, state);
  const descriptors = [...ancestors, descriptor];
  if (TEXT_BLOCK_TYPES.has(node.type)) {
    return [serializeTextBlock(node, nodePosition, descriptors)];
  }
  if (EMPTY_BLOCK_ATOM_TYPES.has(node.type)) {
    const block: MutableBlock = {
      text: "",
      segments: [],
      descriptors,
      pmFrom: nodePosition,
      pmTo: nodePosition + 1,
    };
    if (BLOCK_OBJECT_REPLACEMENT_TYPES.has(node.type)) {
      appendAtomicText(
        block,
        "\uFFFC",
        nodePosition,
        nodePosition + 1,
        node.type,
      );
    }
    return [block];
  }

  const blocks: MutableBlock[] = [];
  let childOffset = 0;
  for (const child of node.content) {
    const childPosition = nodePosition + 1 + childOffset;
    blocks.push(
      ...collectBlocks(child, childPosition, depth + 1, descriptors, state),
    );
    childOffset += nodeSize(child);
  }
  if (blocks.length === 0) {
    const contentPosition = nodePosition + 1;
    blocks.push({
      text: "",
      segments: [],
      descriptors,
      pmFrom: contentPosition,
      pmTo: contentPosition,
    });
  }
  return blocks;
}

function mergeGlobalSegment(
  segments: ProjectionSegment[],
  segment: MappedProjectionSegment,
): void {
  const previous = segments.at(-1);
  if (
    previous?.kind === "linear" &&
    segment.kind === "linear" &&
    previous.canonicalEnd === segment.canonicalStart &&
    previous.to === segment.from
  ) {
    segments[segments.length - 1] = {
      ...previous,
      canonicalEnd: segment.canonicalEnd,
      to: segment.to,
      canonical: {
        from: previous.canonical.from,
        to: segment.canonical.to,
      },
      source: {
        kind: "prosemirror",
        fromPos: previous.source.fromPos,
        toPos: segment.source.toPos,
      },
    };
    return;
  }
  segments.push(segment);
}

function assembleCanonical(
  blocks: readonly MutableBlock[],
  descriptors: readonly MutableBlockDescriptor[],
): CanonicalText {
  let text = "";
  const segments: ProjectionSegment[] = [];
  const descriptorRanges = new Map<number, { from: number; to: number }>();

  for (let index = 0; index < blocks.length; index += 1) {
    if (index > 0) {
      const canonicalStart = text.length;
      const previous = blocks[index - 1];
      const current = blocks[index];
      text += "\n";
      segments.push({
        kind: "synthetic-boundary",
        canonicalStart,
        canonicalEnd: canonicalStart + 1,
        canonical: { from: canonicalStart, to: canonicalStart + 1 },
        boundary: {
          leftPmPos: previous.pmTo,
          rightPmPos: current.pmFrom,
        },
        reason: "block-boundary",
      });
    }
    const canonicalBase = text.length;
    const block = blocks[index];
    text += block.text;
    for (const descriptor of block.descriptors) {
      const existing = descriptorRanges.get(descriptor.key);
      descriptorRanges.set(descriptor.key, {
        from: existing?.from ?? canonicalBase,
        to: canonicalBase + block.text.length,
      });
    }
    for (const segment of block.segments) {
      const canonicalStart = canonicalBase + segment.canonicalStart;
      const canonicalEnd = canonicalBase + segment.canonicalEnd;
      mergeGlobalSegment(segments, {
        ...segment,
        canonicalStart,
        canonicalEnd,
        canonical: { from: canonicalStart, to: canonicalEnd },
      });
    }
  }

  const projection: TextProjectionMap = {
    schemaVersion: 1,
    unit: "utf16",
    canonicalLength: text.length,
    segments,
  };
  const canonicalBlocks: CanonicalBlockSpan[] = descriptors.map(
    (descriptor) => {
      const range = descriptorRanges.get(descriptor.key) ?? { from: 0, to: 0 };
      return {
        id: `B${String(descriptor.key + 1).padStart(6, "0")}`,
        nodeType: descriptor.nodeType,
        range,
        depth: descriptor.depth,
        ...(descriptor.attrs ? { attrs: descriptor.attrs } : {}),
      };
    },
  );

  return freezeDeep({
    unit: "utf16",
    text,
    blocks: canonicalBlocks,
    projection,
    projectionMap: projection,
    diagnostics: [],
  });
}

/**
 * Convert persisted ProseMirror JSON to canonical UTF-16 text and a mapping
 * back to the original document. Invalid or unsupported input never degrades
 * to an empty document.
 */
export function serializeProseMirrorDocument(
  input: string,
  schemaKind: PersistedProseMirrorSchema = "database",
): CanonicalTextSerializationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CANONICAL_INVALID_PM_JSON",
          "Persisted ProseMirror content is not valid JSON",
        ),
      ],
    };
  }

  const invalidUnicodePath = findInvalidUnicode(parsed);
  if (invalidUnicodePath) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "CANONICAL_INVALID_UNICODE",
          "Persisted ProseMirror content contains a lone UTF-16 surrogate",
          invalidUnicodePath,
        ),
      ],
    };
  }

  const rawValidation = validateNode(parsed, "$root", "root");
  if ("error" in rawValidation) {
    return { ok: false, diagnostics: [rawValidation.error] };
  }

  const normalized = normalizeWithPersistedSchema(parsed, schemaKind);
  if (!normalized.ok) {
    return { ok: false, diagnostics: [normalized.diagnostic] };
  }

  const validated = validateNode(normalized.document, "$root", "root");
  if ("error" in validated) {
    return { ok: false, diagnostics: [validated.error] };
  }

  const state: SerializationState = {
    nextBlockKey: 0,
    descriptors: [],
  };

  return {
    ok: true,
    canonical: assembleCanonical(
      collectBlocks(validated.node, 0, 0, [], state),
      state.descriptors,
    ),
  };
}
