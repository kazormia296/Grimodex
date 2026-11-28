import { createHash } from "node:crypto";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import {
  defaultMarkdownParser,
  MarkdownParser,
  type ParseSpec,
} from "prosemirror-markdown";

import { isAgentEventSecretInputSupported } from "../shared/agentEventSecretWritePolicy.js";
import { isAgentForeshadowSecretInputSupported } from "../shared/agentForeshadowSecretWritePolicy.js";
import type { CommandArgs } from "../shared/ipcContract.js";

export {
  isAgentEventSecretInputSupported,
  isAgentForeshadowSecretInputSupported,
};

export type AgentToolInputSpec = {
  readonly fields: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
};

export type AgentToolInputProjection = "model" | "effective";

// This is the exact model-facing contract. It intentionally mirrors the
// public schemas in `toolDefinitions.ts`; renderer/native-only fields must not
// become accepted model keys merely because the renderer uses them on the
// effectful wire payload.
const MODEL_TOOL_INPUT_SPECS: Readonly<Record<string, AgentToolInputSpec>> = {
  create_codex_entry: {
    fields: ["type", "name", "summary", "content", "aliases", "parentId"],
  },
  update_codex_entry: {
    fields: ["id", "name", "summary", "content", "aliases"],
  },
  create_foreshadow: {
    fields: ["title", "intent", "notes", "loadBearing", "secret"],
  },
  update_foreshadow: {
    fields: [
      "id",
      "baseVersion",
      "title",
      "intent",
      "notes",
      "loadBearing",
      "payoffConfirmed",
      "abandoned",
      "secret",
    ],
  },
  create_snippet: { fields: ["title", "content", "sceneId"] },
  create_event: {
    fields: [
      "title",
      "note",
      "kind",
      "precision",
      "primaryCodexId",
      "locationCodexId",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
      // Retired; keep for replayed history so the renderer can explain rejection.
      "secret",
      "revealSceneId",
      "participantCodexIds",
      "sceneIds",
    ],
  },
  update_event: {
    fields: [
      "eventId",
      "title",
      "note",
      "kind",
      "primaryCodexId",
      "locationCodexId",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
      // Retired; keep for replayed history so the renderer can explain rejection.
      "secret",
      "revealSceneId",
    ],
  },
  delete_event: { fields: ["eventId"] },
  stamp_scene_event: { fields: ["sceneId", "eventId"] },
  unstamp_scene_event: { fields: ["sceneId", "eventId"] },
  set_event_participants: { fields: ["eventId", "codexEntryIds"] },
  add_event_relation: { fields: ["causeEventId", "effectEventId"] },
  remove_event_relation: { fields: ["causeEventId", "effectEventId"] },
  apply_ai_tree_plan: { fields: ["kind", "ops"] },
  propose_scene_body: { fields: ["sceneId", "text", "mode"] },
};

// This is the effectful native projection. It includes renderer-derived
// fields and compatibility aliases that are intentionally absent from the
// model contract above. The capability still compares these fields after the
// renderer has resolved OCC/request metadata, so the distinction is only
// about what the model is allowed to request.
const EFFECTIVE_NATIVE_MUTATION_SPECS: Readonly<
  Record<string, AgentToolInputSpec>
> = {
  create_codex_entry: {
    fields: [
      "type",
      "name",
      "summary",
      "content",
      "aliases",
      "parentId",
      "excludedAliases",
      "readings",
      "tagsCache",
      "contextMode",
      "icon",
      "childrenBudget",
      "notes",
    ],
    aliases: { type: "typeSlug" },
  },
  update_codex_entry: {
    fields: [
      "id",
      "type",
      "name",
      "summary",
      "content",
      "aliases",
      "excludedAliases",
      "readings",
      "tagsCache",
      "parentId",
      "contextMode",
      "icon",
      "childrenBudget",
      "notes",
    ],
    aliases: { id: "entryId", type: "typeSlug" },
  },
  create_foreshadow: {
    fields: ["title", "intent", "notes", "loadBearing", "secret"],
  },
  update_foreshadow: {
    fields: [
      "id",
      "baseVersion",
      "title",
      "intent",
      "notes",
      "loadBearing",
      "payoffConfirmed",
      "abandoned",
      "secret",
    ],
    aliases: { id: "foreshadowId" },
  },
  create_snippet: {
    fields: ["title", "content", "sceneId"],
  },
  create_event: {
    fields: [
      "title",
      "note",
      "detail",
      "ordinal",
      "laneGroup",
      "kind",
      "precision",
      "primaryCodexId",
      "locationCodexId",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
      "revealSceneId",
      "participantCodexIds",
      "sceneIds",
    ],
  },
  update_event: {
    fields: [
      "eventId",
      "title",
      "note",
      "detail",
      "ordinal",
      "laneGroup",
      "kind",
      "precision",
      "primaryCodexId",
      "locationCodexId",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
      "revealSceneId",
    ],
  },
  delete_event: { fields: ["eventId"] },
  stamp_scene_event: { fields: ["sceneId", "eventId"] },
  unstamp_scene_event: { fields: ["sceneId", "eventId"] },
  set_event_participants: {
    fields: ["eventId", "codexEntryIds", "participantRoles"],
  },
  add_event_relation: {
    fields: ["causeEventId", "effectEventId"],
  },
  remove_event_relation: {
    fields: ["causeEventId", "effectEventId"],
  },
  apply_ai_tree_plan: { fields: ["kind", "ops"] },
  propose_scene_body: {
    fields: ["sceneId", "text", "mode", "replaceFrom", "replaceTo"],
    aliases: { text: "proposedContent" },
  },
};

const AGENT_TOOL_INPUT_DEFAULTS: Readonly<
  Record<string, Readonly<Record<string, unknown>>>
> = {
  create_codex_entry: {
    summary: null,
    content: null,
    aliases: null,
    parentId: null,
    excludedAliases: null,
    readings: null,
    tagsCache: null,
    contextMode: null,
    icon: null,
    childrenBudget: null,
    notes: null,
  },
  create_foreshadow: {
    intent: null,
    notes: null,
    loadBearing: null,
    secret: false,
  },
  update_foreshadow: {
    title: null,
    intent: null,
    notes: null,
    loadBearing: null,
    payoffConfirmed: null,
    abandoned: null,
    secret: null,
  },
  create_snippet: { content: null, sceneId: null },
  create_event: {
    note: null,
    detail: null,
    laneGroup: null,
    kind: "generic",
    primaryCodexId: null,
    locationCodexId: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    revealSceneId: null,
    participantCodexIds: [],
    sceneIds: [],
  },
  propose_scene_body: {
    mode: "append",
    replaceFrom: null,
    replaceTo: null,
  },
};

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableCanonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(object[key])}`)
    .join(",")}}`;
}

let agentAuthoritySchema: ReturnType<typeof getSchema> | null = null;
let agentAuthorityMarkdownParser: MarkdownParser | null = null;

const AGENT_MARKDOWN_NODE_NAMES: Readonly<Record<string, string>> = {
  list_item: "listItem",
  bullet_list: "bulletList",
  ordered_list: "orderedList",
  code_block: "codeBlock",
  horizontal_rule: "horizontalRule",
  hard_break: "hardBreak",
};
const AGENT_MARKDOWN_MARK_NAMES: Readonly<Record<string, string>> = {
  em: "italic",
  strong: "bold",
};

function getAgentAuthorityMarkdownParser(): MarkdownParser {
  if (agentAuthorityMarkdownParser !== null) {
    return agentAuthorityMarkdownParser;
  }
  agentAuthoritySchema = getSchema([StarterKit.configure()]);
  const tokens = Object.fromEntries(
    Object.entries(defaultMarkdownParser.tokens).flatMap(([name, spec]) => {
      const remapped = remapAgentMarkdownSpec(spec, agentAuthoritySchema!);
      return remapped ? [[name, remapped]] : [];
    }),
  );
  agentAuthorityMarkdownParser = new MarkdownParser(
    agentAuthoritySchema,
    defaultMarkdownParser.tokenizer,
    tokens,
  );
  return agentAuthorityMarkdownParser;
}

function getAgentAuthoritySchema(): ReturnType<typeof getSchema> {
  getAgentAuthorityMarkdownParser();
  if (agentAuthoritySchema === null) {
    throw new Error("agent authority schema is unavailable");
  }
  return agentAuthoritySchema;
}

function remapAgentMarkdownSpec(
  spec: ParseSpec,
  schema: ReturnType<typeof getSchema>,
): ParseSpec | null {
  if (spec.node) {
    const node = AGENT_MARKDOWN_NODE_NAMES[spec.node] ?? spec.node;
    return schema.nodes[node] ? { ...spec, node } : null;
  }
  if (spec.block) {
    const block = AGENT_MARKDOWN_NODE_NAMES[spec.block] ?? spec.block;
    return schema.nodes[block] ? { ...spec, block } : null;
  }
  if (spec.mark) {
    const mark = AGENT_MARKDOWN_MARK_NAMES[spec.mark] ?? spec.mark;
    return schema.marks[mark] ? { ...spec, mark } : null;
  }
  return spec;
}

function stripAuthorshipMarks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAuthorshipMarks);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "marks" && Array.isArray(child)) {
      normalized[key] = child
        .filter((mark) => !isRecord(mark) || mark.type !== "authorship")
        .map(stripAuthorshipMarks);
    } else if (key === "content" && Array.isArray(child)) {
      normalized[key] = child.map(stripAuthorshipMarks);
    } else {
      normalized[key] = stripAuthorshipMarks(child);
    }
  }
  return normalized;
}

function invalidRichTextValue(value: unknown): Record<string, unknown> {
  return {
    __grimodexInvalidRichText: true,
    value: typeof value === "string" ? value : String(value),
  };
}

/** The model contract is Markdown, even when its text happens to be JSON. */
function canonicalModelRichText(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string") return invalidRichTextValue(value);
  try {
    return stripAuthorshipMarks(
      getAgentAuthorityMarkdownParser().parse(value).toJSON(),
    );
  } catch {
    return invalidRichTextValue(value);
  }
}

/** The native wire contract is schema-validated serialized ProseMirror JSON. */
function canonicalEffectiveRichText(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string") return invalidRichTextValue(value);
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return invalidRichTextValue(value);
    const withoutRendererAuthorship = stripAuthorshipMarks(parsed);
    const document = ProseMirrorNode.fromJSON(
      getAgentAuthoritySchema(),
      withoutRendererAuthorship,
    );
    document.check();
    if (document.type.name !== "doc") return invalidRichTextValue(value);
    return stripAuthorshipMarks(document.toJSON());
  } catch {
    return invalidRichTextValue(value);
  }
}

export interface MainOwnedAuthorshipMarkAttrs {
  readonly source: "ai";
  readonly timestamp: string;
  readonly model: string | null;
  readonly chatMessageId: string;
  readonly traceId: string;
}

function parentAllowsInlineMarks(
  schema: ReturnType<typeof getSchema>,
  parentTypeName: string | null,
): boolean {
  if (parentTypeName === null) return true;
  // A NodeSpec with marks: "" rejects every inline mark. StarterKit's
  // codeBlock uses this contract, so its text remains attributable through
  // authorship_spans rather than receiving an invalid inline mark.
  return schema.nodes[parentTypeName]?.spec.marks !== "";
}

/**
 * Rebuild authorship marks after the renderer-authorship projection has been
 * stripped. The capability boundary owns these values; renderer-provided
 * source/model/chat/trace attrs must never be persisted as provenance.
 */
export function applyMainOwnedAuthorshipMarks(
  value: unknown,
  attrs: MainOwnedAuthorshipMarkAttrs,
): unknown {
  const schema = getAgentAuthoritySchema();
  const apply = (current: unknown, parentTypeName: string | null): unknown => {
    if (Array.isArray(current)) {
      return current.map((child) => apply(child, parentTypeName));
    }
    if (!isRecord(current)) return current;

    const normalized: CommandArgs = { ...current };
    const nodeTypeName =
      typeof normalized.type === "string" ? normalized.type : null;
    if (nodeTypeName === "text" && typeof normalized.text === "string") {
      const marks = Array.isArray(normalized.marks)
        ? normalized.marks.filter(
            (mark) => !isRecord(mark) || mark.type !== "authorship",
          )
        : [];
      normalized.marks = parentAllowsInlineMarks(schema, parentTypeName)
        ? [
            ...marks,
            {
              type: "authorship",
              attrs: { ...attrs },
            },
          ]
        : [];
    }
    if (Array.isArray(normalized.content)) {
      normalized.content = normalized.content.map((child) =>
        apply(child, nodeTypeName),
      );
    }
    return normalized;
  };
  return apply(value, null);
}

function canonicalAgentInputValue(
  field: string,
  value: unknown,
  projection: AgentToolInputProjection,
): unknown {
  if (field === "content" || field === "detail") {
    return projection === "model"
      ? canonicalModelRichText(value)
      : canonicalEffectiveRichText(value);
  }
  if (
    field === "aliases" ||
    field === "participantCodexIds" ||
    field === "sceneIds"
  ) {
    const normalizeStringArray = (items: unknown[]): string[] =>
      items
        .map((item) => String(item).trim())
        .filter((item) => item.length > 0);
    if (Array.isArray(value)) return normalizeStringArray(value);
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return normalizeStringArray(parsed);
        }
      } catch {
        // Keep malformed/non-JSON values bound as strings; Native will reject them.
      }
    }
  }
  if (
    field === "excludedAliases" ||
    field === "readings" ||
    field === "tagsCache"
  ) {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        // Keep malformed/non-JSON values bound as strings; Native will reject them.
      }
    }
  }
  if (
    field === "title" ||
    field === "name" ||
    field === "type" ||
    field === "id" ||
    field === "eventId" ||
    field === "foreshadowId" ||
    field === "entryId" ||
    field === "text"
  ) {
    return typeof value === "string" ? value.trim() : value;
  }
  return value;
}

function canonicalAgentToolInput(
  toolName: string,
  source: unknown,
  enforceModelShape = false,
  projection: AgentToolInputProjection = enforceModelShape
    ? "model"
    : "effective",
  valueProjection: AgentToolInputProjection = projection,
): string | null {
  const spec = (
    projection === "model"
      ? MODEL_TOOL_INPUT_SPECS
      : EFFECTIVE_NATIVE_MUTATION_SPECS
  )[toolName];
  if (!spec || !isRecord(source)) return null;
  if (enforceModelShape) {
    const acceptedKeys = new Set(spec.fields);
    if (Object.keys(source).some((key) => !acceptedKeys.has(key))) return null;
  }
  const defaults = AGENT_TOOL_INPUT_DEFAULTS[toolName] ?? {};
  const wireAliases =
    projection === "model"
      ? EFFECTIVE_NATIVE_MUTATION_SPECS[toolName]?.aliases
      : spec.aliases;
  const normalized: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const wireField = wireAliases?.[field] ?? field;
    const raw = Object.hasOwn(source, field)
      ? source[field]
      : source[wireField];
    const value = raw === undefined ? defaults[field] : raw;
    if (
      (toolName === "create_event" || toolName === "update_event") &&
      field === "secret" &&
      value === false
    ) {
      // Legacy false is equivalent to omission because event secrecy is retired.
      continue;
    }
    if (value !== undefined) {
      normalized[field] = canonicalAgentInputValue(
        field,
        value,
        valueProjection,
      );
    }
  }
  return stableCanonicalJson(normalized);
}

export function canonicalAgentToolInputDigest(
  toolName: string,
  source: unknown,
  enforceModelShape = false,
  projection: AgentToolInputProjection = enforceModelShape
    ? "model"
    : "effective",
  valueProjection: AgentToolInputProjection = projection,
): string | null {
  const canonical = canonicalAgentToolInput(
    toolName,
    source,
    enforceModelShape,
    projection,
    valueProjection,
  );
  if (canonical === null) return null;
  return createHash("sha256").update(canonical).digest("hex");
}

/** Model-input digest with the retired secret fields rejected at the same boundary. */
export function agentToolInputDigest(
  toolName: string,
  source: unknown,
): string | null {
  if (
    !isRecord(source) ||
    !isAgentEventSecretInputSupported(toolName, source) ||
    !isAgentForeshadowSecretInputSupported(toolName, source)
  ) {
    return null;
  }
  return canonicalAgentToolInputDigest(toolName, source, true);
}

function isRecord(value: unknown): value is CommandArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export {
  AGENT_TOOL_INPUT_DEFAULTS,
  EFFECTIVE_NATIVE_MUTATION_SPECS,
  canonicalAgentInputValue,
  canonicalAgentToolInput,
  isRecord,
  stableCanonicalJson,
};
