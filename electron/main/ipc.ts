/**
 * invoke ルーター（設計書 §2 / §5.2、Phase 2 S4）。
 *
 * `ipcMain.handle("grim:invoke")` 1 本に集約し、ルーティングの実体は
 * 純関数 `dispatchInvoke`（electron/shared/ipcContract.ts — node 環境で
 * 単体テスト済み）へ委譲する。ここは electron グルーのみ:
 * - 送信元窓の解決（保存ダイアログなど窓単位コマンドへの束縛）
 * - fail-soft outcome の main 側ログ（A6 監査の集計ポイント）
 */
import { BrowserWindow, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import {
  defaultMarkdownParser,
  MarkdownParser,
  type ParseSpec,
} from "prosemirror-markdown";

import {
  bindCanonicalAuthorityContext,
  dispatchInvoke,
  IPC,
  IPC_BACKEND_UNAVAILABLE_MARKER,
  IPC_UNIMPLEMENTED_MARKER,
} from "../shared/ipcContract.js";
import type {
  CanonicalAuthorityRoute,
  CommandArgs,
  Envelope,
  NapiBackendLike,
  SecretsResolver,
  ShellCommandHandlers,
} from "../shared/ipcContract.js";
import {
  buildShellCommandHandlers,
  registerShellBridgeHandlers,
} from "./shellCommands.js";
import {
  focusPanelWindow,
  hasPanelWindow,
  openPanelWindow,
} from "./windows.js";
import { scheduleNarrativeMaintenanceForegroundRelease } from "./narrativeMaintenance.js";
import type { NarrativeMaintenanceCiSeam } from "./narrativeMaintenanceCiSeam.js";

const GENERIC_CANONICAL_WRITER_COMMANDS = new Set([
  "snippet_create",
  "snippet_update",
  "snippet_delete",
]);

// Codex has two renderer-facing writer families. The `agent_codex_*` commands
// are reserved for capability-bound Agent tool calls; these aliases preserve
// the human/import/history renderer API without weakening that boundary.
const CODEX_RENDERER_COMMANDS = new Set([
  "codex_create",
  "codex_update",
  "codex_delete",
  "codex_mutate",
]);

// Chronicle has the same split as Codex: manual/import/history/restore
// mutations use explicit renderer commands, while every `agent_*` command
// remains capability-bound below.
const RENDERER_CHRONICLE_COMMANDS = new Set([
  "event_create",
  "event_update",
  "event_delete",
  "chronicle_bulk_mutate",
  "event_participants_set",
  "scene_event_link",
  "scene_event_link_batch",
  "scene_event_unlink",
  "event_relation_add",
  "event_relation_remove",
]);

const HUMAN_ONLY_CANONICAL_WRITER_COMMANDS = new Set([
  "entity_tags_set",
  "project_create",
  "project_patch",
  "project_delete",
  "temporal_scene_patch",
  "foreshadow_link_codex",
  "foreshadow_unlink_codex",
  "foreshadow_set_setup_strength",
  "foreshadow_resolve_orphan",
  "foreshadow_save_anchors_for_scene",
]);

// `sessionId` remains the renderer recorder/writer correlation identity. The
// External Write Feed compares change_events.session_id with that value, so
// replacing it here would make a successful self-write look external and
// invalidate its just-created Undo command. Keep the authority identity in a
// separate main-owned field instead; it is used only for the authority/audit
// boundary and is never used as the Change Feed writer session.
const rendererAuthoritySessions = new Map<number, string>();

const AGENT_CHRONICLE_COMMANDS = new Set([
  "agent_event_create",
  "agent_event_update",
  "agent_event_delete",
  "agent_chronicle_bulk_mutate",
  "agent_event_set_participants",
  "agent_scene_event_link",
  "agent_scene_event_link_batch",
  "agent_scene_event_unlink",
  "agent_event_relation_add",
  "agent_event_relation_remove",
]);

type AgentAuthorityPolicy = "knowledgeWrite" | "structureWrite" | "bodyWrite";

interface AgentAuthorityCapabilityRecord {
  readonly senderId: number;
  readonly projectId: string;
  readonly toolName: string;
  readonly command: string;
  readonly requestId: string;
  readonly toolCallId: string;
  readonly policy: AgentAuthorityPolicy;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly model: string | null;
  readonly modelInput: Record<string, unknown>;
  readonly expectedEntityId: string | null;
  readonly canonicalInputDigest: string;
  readonly mainOwnedProvenanceId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

interface AgentAuthorityCapabilityGrant {
  readonly capability: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly mainOwnedProvenanceId: string;
  /** Main-issued identity for create tools that need to reach Native unchanged. */
  readonly expectedEntityId?: string;
}

const AGENT_AUTHORITY_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const agentAuthorityCapabilities = new Map<
  string,
  AgentAuthorityCapabilityRecord
>();

const AGENT_TOOL_COMMANDS: Readonly<
  Record<string, { command: string; policy: AgentAuthorityPolicy }>
> = {
  create_codex_entry: {
    command: "agent_codex_create",
    policy: "knowledgeWrite",
  },
  update_codex_entry: {
    command: "agent_codex_update",
    policy: "knowledgeWrite",
  },
  create_foreshadow: {
    command: "agent_foreshadow_create",
    policy: "knowledgeWrite",
  },
  update_foreshadow: {
    command: "agent_foreshadow_update",
    policy: "knowledgeWrite",
  },
  create_snippet: { command: "agent_snippet_create", policy: "knowledgeWrite" },
  create_event: { command: "agent_event_create", policy: "knowledgeWrite" },
  update_event: { command: "agent_event_update", policy: "knowledgeWrite" },
  delete_event: { command: "agent_event_delete", policy: "knowledgeWrite" },
  stamp_scene_event: {
    command: "agent_scene_event_link",
    policy: "knowledgeWrite",
  },
  unstamp_scene_event: {
    command: "agent_scene_event_unlink",
    policy: "knowledgeWrite",
  },
  set_event_participants: {
    command: "agent_event_set_participants",
    policy: "knowledgeWrite",
  },
  add_event_relation: {
    command: "agent_event_relation_add",
    policy: "knowledgeWrite",
  },
  remove_event_relation: {
    command: "agent_event_relation_remove",
    policy: "knowledgeWrite",
  },
  apply_ai_tree_plan: {
    command: "ai_tree_plan_apply",
    policy: "structureWrite",
  },
  propose_scene_body: {
    command: "agent_propose_scene_body",
    policy: "bodyWrite",
  },
};
const AGENT_AUTHORITY_COMMANDS = new Set([
  ...Object.values(AGENT_TOOL_COMMANDS).map(({ command }) => command),
  // These compatibility writers are still allowed to classify an AI
  // payload as interactive, so they must not become a capability bypass
  // merely because no current chat tool targets them directly.
  "agent_codex_mutate",
  ...AGENT_CHRONICLE_COMMANDS,
]);

// Undo/redo is a renderer-facing command, but its journal lineage must be
// issued by this main-process session. Keep the route explicit instead of
// letting the generic Agent command set accidentally classify it as an
// interactive tool call.
const HISTORY_REPLAY_COMMANDS = new Set(["agent_apply_undo_journal"]);

// Only successful forward writers may mint a journal capability for a later
// history replay. A response from a read command must never be able to plant
// an arbitrary journal id into this registry merely because it happens to
// contain an `undoJournalId`-shaped field.
const HISTORY_JOURNAL_WRITER_COMMANDS = new Set([
  ...AGENT_AUTHORITY_COMMANDS,
  ...GENERIC_CANONICAL_WRITER_COMMANDS,
  ...CODEX_RENDERER_COMMANDS,
  ...RENDERER_CHRONICLE_COMMANDS,
  ...HUMAN_ONLY_CANONICAL_WRITER_COMMANDS,
  "tree_node_create",
  "tree_node_patch",
  "tree_node_delete",
  "ai_tree_plan_apply",
  "ai_tree_plan_undo",
  "foreshadow_create",
  "foreshadow_update",
  "foreshadow_delete",
  "foreshadow_update_setup",
  "foreshadow_setup_create_ai",
]);

const MAX_RENDERER_HISTORY_JOURNALS = 4096;
const rendererHistoryJournals = new Map<string, number>();

function rendererHistoryJournalKey(
  senderId: number,
  projectId: string,
  journalId: string,
): string {
  return `${senderId}\u0000${projectId}\u0000${journalId}`;
}

/** Record a Main-issued journal identity for the current renderer session. */
export function recordRendererHistoryJournalForIpc(
  senderId: number,
  projectId: string,
  journalId: string,
): void {
  if (
    !Number.isInteger(senderId) ||
    !isNonEmptyTrimmedString(projectId) ||
    !isNonEmptyTrimmedString(journalId)
  ) {
    return;
  }
  const key = rendererHistoryJournalKey(senderId, projectId, journalId);
  rendererHistoryJournals.delete(key);
  rendererHistoryJournals.set(key, Date.now());
  while (rendererHistoryJournals.size > MAX_RENDERER_HISTORY_JOURNALS) {
    const oldest = rendererHistoryJournals.keys().next().value;
    if (typeof oldest !== "string") break;
    rendererHistoryJournals.delete(oldest);
  }
}

function hasRendererHistoryJournal(
  senderId: number,
  projectId: string,
  journalId: string,
): boolean {
  return rendererHistoryJournals.has(
    rendererHistoryJournalKey(senderId, projectId, journalId),
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim()
  );
}

function agentToolRequestId(
  toolName: string,
  projectId: string,
  toolCallId: string,
): string {
  const digest = createHash("sha256")
    .update(`${toolName}\0${projectId}\0${toolCallId}`)
    .digest("hex");
  return `agent-tool:${digest}`;
}

type AgentToolInputSpec = {
  readonly fields: readonly string[];
  readonly aliases?: Readonly<Record<string, string>>;
};

type AgentToolInputProjection = "model" | "effective";

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
      "primaryCodexId",
      "locationCodexId",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
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
      "secret",
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
    secret: true,
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
    precision: "exact",
    primaryCodexId: null,
    locationCodexId: null,
    startTime: null,
    endTime: null,
    startMinute: null,
    endMinute: null,
    secret: false,
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

function canonicalAgentToolInputDigest(
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

function parsePolicyAllows(
  raw: unknown,
  policy: AgentAuthorityPolicy,
): boolean {
  // `parseAiPolicy` treats a legacy NULL policy as the documented default
  // (full). Keep this main-side gate aligned with that canonical policy
  // contract while still failing closed for an unknown serialized preset.
  if (raw === null || raw === undefined) return true;
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try {
    const parsed = JSON.parse(raw) as {
      preset?: unknown;
      toggles?: Record<string, unknown>;
    };
    const preset = parsed.preset;
    const toggles = parsed.toggles;
    if (toggles && typeof toggles === "object") {
      if (typeof toggles[policy] === "boolean") return toggles[policy] === true;
    }
    const presetDefaults: Record<
      string,
      Record<AgentAuthorityPolicy, boolean>
    > = {
      full: { knowledgeWrite: true, structureWrite: true, bodyWrite: true },
      "assist-off": {
        knowledgeWrite: true,
        structureWrite: true,
        bodyWrite: false,
      },
      "review-only": {
        knowledgeWrite: false,
        structureWrite: false,
        bodyWrite: false,
      },
      off: { knowledgeWrite: false, structureWrite: false, bodyWrite: false },
      custom: {
        knowledgeWrite: false,
        structureWrite: false,
        bodyWrite: false,
      },
    };
    return typeof preset !== "string"
      ? false
      : (presetDefaults[preset]?.[policy] ?? false);
  } catch {
    return false;
  }
}

function pruneAgentAuthorityCapabilities(now = Date.now()): void {
  for (const [token, record] of agentAuthorityCapabilities) {
    if (record.expiresAt <= now) agentAuthorityCapabilities.delete(token);
  }
}

async function policyAllowsAgentTool(
  backend: NapiBackendLike,
  projectId: string,
  policy: AgentAuthorityPolicy,
): Promise<boolean> {
  const raw = await backend.dbExecute(
    "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
    [projectId],
    "get",
  );
  const parsed = JSON.parse(raw) as { rows?: unknown };
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  if (rows.length === 0) return false;
  const first = Array.isArray(rows[0]) ? rows[0][0] : undefined;
  return parsePolicyAllows(first, policy);
}

function responseBlocks(response: unknown): Array<Record<string, unknown>> {
  if (!isRecord(response) || !Array.isArray(response.blocks)) return [];
  return response.blocks.filter((block): block is Record<string, unknown> =>
    isRecord(block),
  );
}

function cloneJsonRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

interface AgentProjectionField {
  present: boolean;
  fromDefault: boolean;
  conflict: boolean;
  value: unknown;
}

function readAgentProjectionField(
  spec: AgentToolInputSpec,
  field: string,
  source: Record<string, unknown>,
  defaults: Readonly<Record<string, unknown>> | undefined,
  valueProjection: AgentToolInputProjection,
): AgentProjectionField {
  const wireField = spec.aliases?.[field] ?? field;
  const hasField = Object.hasOwn(source, field) && source[field] !== undefined;
  const hasWireField =
    wireField !== field &&
    Object.hasOwn(source, wireField) &&
    source[wireField] !== undefined;
  if (hasField && hasWireField) {
    const fieldValue = canonicalAgentInputValue(
      field,
      source[field],
      valueProjection,
    );
    const wireValue = canonicalAgentInputValue(
      field,
      source[wireField],
      valueProjection,
    );
    if (stableCanonicalJson(fieldValue) !== stableCanonicalJson(wireValue)) {
      return {
        present: true,
        fromDefault: false,
        conflict: true,
        value: undefined,
      };
    }
  }
  if (hasField || hasWireField) {
    return {
      present: true,
      fromDefault: false,
      conflict: false,
      value: canonicalAgentInputValue(
        field,
        hasField ? source[field] : source[wireField],
        valueProjection,
      ),
    };
  }
  if (
    defaults &&
    Object.hasOwn(defaults, field) &&
    defaults[field] !== undefined
  ) {
    return {
      present: true,
      fromDefault: true,
      conflict: false,
      value: canonicalAgentInputValue(field, defaults[field], valueProjection),
    };
  }
  return {
    present: false,
    fromDefault: false,
    conflict: false,
    value: undefined,
  };
}

/** Compare every effectful field before provenance binding reaches Native. */
function agentMutationProjectionMatches(
  toolName: string,
  modelInput: Record<string, unknown>,
  payload: CommandArgs,
): boolean {
  const spec = EFFECTIVE_NATIVE_MUTATION_SPECS[toolName];
  if (
    !spec ||
    canonicalAgentToolInput(toolName, modelInput, true, "model", "model") ===
      null
  ) {
    return false;
  }
  const defaults = AGENT_TOOL_INPUT_DEFAULTS[toolName];
  for (const field of spec.fields) {
    const expected = readAgentProjectionField(
      spec,
      field,
      modelInput,
      defaults,
      "model",
    );
    const actual = readAgentProjectionField(
      spec,
      field,
      payload,
      undefined,
      "effective",
    );
    if (expected.conflict || actual.conflict) return false;
    if (!expected.present) {
      if (actual.present) return false;
      continue;
    }
    if (!actual.present) {
      // Main can fill a documented create/update default, but it must never
      // silently turn an explicitly requested update field into a no-op.
      if (!expected.fromDefault) return false;
      continue;
    }
    if (
      stableCanonicalJson(expected.value) !== stableCanonicalJson(actual.value)
    ) {
      return false;
    }
  }
  return true;
}

function mainOwnedEntityId(toolName: string, requestId: string): string | null {
  switch (toolName) {
    case "create_codex_entry":
      return `codex-entry:${requestId}`;
    case "create_snippet":
      return `snippet:${requestId}`;
    case "create_event":
    case "create_foreshadow":
      return randomUUID();
    default:
      return null;
  }
}

function resolvedTreeRef(
  ref: unknown,
  tempIds: ReadonlyMap<string, string>,
): string | null | undefined {
  if (ref === null) return null;
  if (typeof ref !== "string") return undefined;
  return ref.startsWith("tmp:") ? tempIds.get(ref) : ref;
}

/**
 * The renderer still prepares the OCC payload for the existing Native writer,
 * but the capability boundary checks that preparation against the model IR.
 * Native repeats the placement proof against the database snapshot; this
 * first check rejects obvious create/update retargets before dispatch.
 */
function treeMutationProjectionMatches(
  modelInput: Record<string, unknown>,
  payload: CommandArgs,
): boolean {
  const modelOps = modelInput.ops;
  const creates = payload.creates;
  const updates = payload.updates;
  if (
    !Array.isArray(modelOps) ||
    !Array.isArray(creates) ||
    !Array.isArray(updates)
  ) {
    return false;
  }
  const createOps = modelOps.filter(
    (op): op is CommandArgs => isRecord(op) && op.op === "create",
  );
  const moveOps = modelOps.filter(
    (op): op is CommandArgs => isRecord(op) && op.op === "move",
  );
  const renameOps = modelOps.filter(
    (op): op is CommandArgs => isRecord(op) && op.op === "rename",
  );
  const createRows = creates.filter(isRecord);
  if (
    createRows.length !== creates.length ||
    createRows.length !== createOps.length
  ) {
    return false;
  }
  const tempToId = new Map<string, string>();
  for (const row of createRows) {
    if (typeof row.tempId !== "string" || typeof row.id !== "string")
      return false;
    if (tempToId.has(row.tempId)) return false;
    tempToId.set(row.tempId, row.id);
  }
  for (const op of createOps) {
    const row = createRows.find((candidate) => candidate.tempId === op.tempId);
    if (!row) return false;
    const expectedParent = resolvedTreeRef(op.parentRef, tempToId);
    if (
      expectedParent === undefined ||
      row.parentId !== expectedParent ||
      row.nodeType !== op.nodeType ||
      row.title !== op.title ||
      (row.synopsis ?? null) !== (op.synopsis ?? null)
    ) {
      return false;
    }
  }

  const expectedUpdates = new Map<
    string,
    { move?: CommandArgs; rename?: CommandArgs }
  >();
  for (const op of moveOps) {
    if (typeof op.nodeId !== "string") return false;
    const entry = expectedUpdates.get(op.nodeId) ?? {};
    if (entry.move) return false;
    entry.move = op;
    expectedUpdates.set(op.nodeId, entry);
  }
  for (const op of renameOps) {
    if (typeof op.nodeId !== "string") return false;
    const entry = expectedUpdates.get(op.nodeId) ?? {};
    if (entry.rename) return false;
    entry.rename = op;
    expectedUpdates.set(op.nodeId, entry);
  }
  const updateRows = updates.filter(isRecord);
  if (
    updateRows.length !== updates.length ||
    updateRows.length !== expectedUpdates.size
  ) {
    return false;
  }
  for (const row of updateRows) {
    if (typeof row.id !== "string") return false;
    const expected = expectedUpdates.get(row.id);
    if (!expected) return false;
    const move = expected.move;
    const rename = expected.rename;
    if (move) {
      if (!isRecord(row.placement)) return false;
      const expectedParent = resolvedTreeRef(move.newParentRef, tempToId);
      if (
        expectedParent === undefined ||
        row.placement.parentId !== expectedParent
      ) {
        return false;
      }
    } else if (row.placement !== null) {
      return false;
    }
    if (rename) {
      if (row.title !== rename.title) return false;
    } else if (row.title !== null) {
      return false;
    }
  }
  return true;
}

interface MainOwnedAuthorshipSpan {
  fromPos: number;
  toPos: number;
  source: "ai";
  model: string;
  timestamp: string;
  chatMsgId: string;
  traceId: string;
  lane: "summary" | "content";
}

function mainOwnedAuthorshipTimestamp(
  capability: AgentAuthorityCapabilityRecord,
): string {
  return new Date(capability.issuedAt).toISOString();
}

function mainOwnedContentSpans(
  content: unknown,
  model: string | null,
  chatMessageId: string,
  traceId: string,
  timestamp: string,
): MainOwnedAuthorshipSpan[] {
  if (typeof content !== "string" || content.length === 0) return [];
  try {
    const root = JSON.parse(content) as unknown;
    const spans: MainOwnedAuthorshipSpan[] = [];
    const visit = (node: unknown, position: number): number => {
      if (!isRecord(node)) return position;
      if (node.type === "text" && typeof node.text === "string") {
        spans.push({
          fromPos: position,
          toPos: position + node.text.length,
          source: "ai",
          model: model ?? "__lane_content__",
          timestamp,
          chatMsgId: chatMessageId,
          traceId,
          lane: "content",
        });
        return position + node.text.length;
      }
      let cursor = position;
      if (Array.isArray(node.content)) {
        for (const child of node.content) cursor = visit(child, cursor);
      }
      return cursor;
    };
    visit(root, 0);
    return spans;
  } catch {
    return [];
  }
}

function mainOwnedCodexAuthorship(
  payload: CommandArgs,
  capability: AgentAuthorityCapabilityRecord,
): MainOwnedAuthorshipSpan[] {
  const spans: MainOwnedAuthorshipSpan[] = [];
  const timestamp = mainOwnedAuthorshipTimestamp(capability);
  if (typeof payload.summary === "string" && payload.summary.length > 0) {
    spans.push({
      fromPos: 0,
      toPos: payload.summary.length,
      source: "ai",
      model: capability.model ?? "__lane_summary__",
      timestamp,
      chatMsgId: capability.chatMessageId,
      traceId: capability.mainOwnedProvenanceId,
      lane: "summary",
    });
  }
  spans.push(
    ...mainOwnedContentSpans(
      payload.content,
      capability.model,
      capability.chatMessageId,
      capability.mainOwnedProvenanceId,
      timestamp,
    ),
  );
  return spans;
}

function bindMainOwnedRichTextFields(
  bound: CommandArgs,
  capability: AgentAuthorityCapabilityRecord,
): void {
  const spec = EFFECTIVE_NATIVE_MUTATION_SPECS[capability.toolName];
  if (!spec) return;
  const defaults = AGENT_TOOL_INPUT_DEFAULTS[capability.toolName];
  for (const field of ["content", "detail"]) {
    if (!spec.fields.includes(field)) continue;
    const expected = readAgentProjectionField(
      spec,
      field,
      capability.modelInput,
      defaults,
      "model",
    );
    if (!expected.present || expected.conflict) continue;
    const wireField = spec.aliases?.[field] ?? field;
    // The model Markdown projection is converted to canonical PM JSON here.
    // Renderer authorship marks/attrs are never trusted; they are discarded
    // before main-owned provenance is rebuilt for Native persistence.
    const mainOwnedValue = applyMainOwnedAuthorshipMarks(expected.value, {
      source: "ai",
      timestamp: mainOwnedAuthorshipTimestamp(capability),
      model: capability.model,
      chatMessageId: capability.chatMessageId,
      traceId: capability.mainOwnedProvenanceId,
    });
    bound[wireField] =
      mainOwnedValue === null || typeof mainOwnedValue === "string"
        ? mainOwnedValue
        : JSON.stringify(mainOwnedValue);
    if (wireField !== field) delete bound[field];
  }
}

function bindMainOwnedAgentMutation(
  payload: CommandArgs,
  capability: AgentAuthorityCapabilityRecord,
): CommandArgs | null {
  if (
    !agentMutationProjectionMatches(
      capability.toolName,
      capability.modelInput,
      payload,
    )
  ) {
    return null;
  }
  if (
    capability.toolName === "apply_ai_tree_plan" &&
    !treeMutationProjectionMatches(capability.modelInput, payload)
  ) {
    return null;
  }
  const bound: CommandArgs = {
    ...payload,
    projectId: capability.projectId,
    executionId: capability.executionId,
    mainOwnedProvenanceId: capability.mainOwnedProvenanceId,
    chatMessageId: capability.chatMessageId,
    toolCallId: capability.toolCallId,
    traceId: capability.mainOwnedProvenanceId,
    model: capability.model,
  };
  if (
    capability.toolName === "create_codex_entry" ||
    capability.toolName === "update_codex_entry" ||
    capability.toolName === "create_event" ||
    capability.toolName === "update_event" ||
    capability.toolName === "delete_event" ||
    capability.toolName === "stamp_scene_event" ||
    capability.toolName === "unstamp_scene_event" ||
    capability.toolName === "set_event_participants" ||
    capability.toolName === "add_event_relation" ||
    capability.toolName === "remove_event_relation" ||
    capability.toolName === "apply_ai_tree_plan"
  ) {
    // Native records `surface` in Undo Journal / source provenance. It is
    // transport metadata, never model intent, so the main owns it for every
    // interactive mutation that carries the field.
    bound.surface = "in-app-agent";
  }
  if (capability.toolName === "propose_scene_body") {
    bound.sourceSurface = "in-app-agent";
  }
  bindMainOwnedRichTextFields(bound, capability);
  if (capability.expectedEntityId !== null) {
    const identityField = (() => {
      switch (capability.toolName) {
        case "create_codex_entry":
          return "entryId";
        case "create_snippet":
          return "snippetId";
        case "create_event":
          return "eventId";
        case "create_foreshadow":
          return "foreshadowId";
        default:
          return null;
      }
    })();
    if (identityField) {
      if (
        bound[identityField] !== undefined &&
        bound[identityField] !== capability.expectedEntityId
      ) {
        return null;
      }
      bound[identityField] = capability.expectedEntityId;
    }
  }
  if (capability.toolName === "apply_ai_tree_plan") {
    bound.ops = cloneJsonRecord({ ops: capability.modelInput.ops }).ops;
  }
  if (
    capability.toolName === "create_codex_entry" ||
    capability.toolName === "update_codex_entry"
  ) {
    const spans = mainOwnedCodexAuthorship(bound, capability);
    const hasAuthorshipPatch =
      capability.toolName === "create_codex_entry" ||
      bound.summary !== undefined ||
      bound.content !== undefined;
    bound.authorshipSpans = hasAuthorshipPatch
      ? spans.map(({ lane: _lane, ...span }) => span)
      : null;
    if (capability.toolName === "update_codex_entry" && hasAuthorshipPatch) {
      bound.authorshipSpanLanes = spans.map((span) => span.lane);
    } else if (capability.toolName === "update_codex_entry") {
      bound.authorshipSpanLanes = null;
    }
    if (capability.toolName === "create_codex_entry") {
      bound.sourceChatMessageId = capability.chatMessageId;
    }
  } else if (capability.toolName === "create_snippet") {
    bound.sourceChatMessageId = capability.chatMessageId;
    bound.authorshipSpans = mainOwnedContentSpans(
      bound.content,
      capability.model,
      capability.chatMessageId,
      capability.mainOwnedProvenanceId,
      mainOwnedAuthorshipTimestamp(capability),
    ).map(({ lane: _lane, ...span }) => span);
  }
  return bound;
}

async function issueAgentAuthorityCapabilitiesForSender(
  senderId: number,
  args: CommandArgs,
  response: unknown,
  backend: NapiBackendLike | null,
): Promise<unknown> {
  if (!backend || !isRecord(args.auditContext)) return response;
  if (args.auditContext.pathId !== "chat_agent_main") return response;
  const projectId = args.auditContext.projectId;
  const executionId = args.auditContext.executionId;
  const chatMessageId = args.chatMessageId;
  if (
    !isNonEmptyTrimmedString(projectId) ||
    !isNonEmptyTrimmedString(executionId) ||
    !isNonEmptyTrimmedString(chatMessageId)
  ) {
    return response;
  }

  pruneAgentAuthorityCapabilities();
  const issued: Record<string, AgentAuthorityCapabilityGrant> = {};
  for (const block of responseBlocks(response)) {
    if (block.type !== "tool_use") continue;
    const toolCallId = block.id;
    const toolName = block.name;
    const definition =
      AGENT_TOOL_COMMANDS[typeof toolName === "string" ? toolName : ""];
    if (
      !definition ||
      !isNonEmptyTrimmedString(toolCallId) ||
      !isNonEmptyTrimmedString(toolName)
    ) {
      continue;
    }
    if (!(await policyAllowsAgentTool(backend, projectId, definition.policy))) {
      continue;
    }
    const canonicalInputDigest = canonicalAgentToolInputDigest(
      toolName,
      block.input,
      true,
    );
    if (!canonicalInputDigest) continue;
    if (!isRecord(block.input)) continue;
    const now = Date.now();
    const token = randomUUID();
    const mainOwnedProvenanceId = randomUUID();
    const requestId = agentToolRequestId(toolName, projectId, toolCallId);
    const expectedEntityId = mainOwnedEntityId(toolName, requestId);
    agentAuthorityCapabilities.set(token, {
      senderId,
      projectId,
      toolName,
      command: definition.command,
      requestId,
      toolCallId,
      policy: definition.policy,
      executionId,
      chatMessageId,
      model: typeof args.model === "string" ? args.model : null,
      modelInput: cloneJsonRecord(block.input),
      expectedEntityId,
      canonicalInputDigest,
      mainOwnedProvenanceId,
      issuedAt: now,
      expiresAt: now + AGENT_AUTHORITY_CAPABILITY_TTL_MS,
    });
    issued[toolCallId] = {
      capability: token,
      executionId,
      chatMessageId,
      mainOwnedProvenanceId,
      ...(expectedEntityId ? { expectedEntityId } : {}),
    };
  }
  if (Object.keys(issued).length === 0 || !isRecord(response)) return response;
  return { ...response, agentAuthorityCapabilities: issued };
}

function consumeAgentAuthorityCapability(
  cmd: string,
  payload: CommandArgs,
  senderId: number,
): AgentAuthorityCapabilityRecord | null {
  const capability = payload.agentAuthorityCapability;
  if (!isNonEmptyTrimmedString(capability)) return null;
  pruneAgentAuthorityCapabilities();
  const record = agentAuthorityCapabilities.get(capability);
  if (!record) return null;
  // Capabilities are one-shot. A malformed/re-targeted attempt must not leave
  // a valid token available for replay in a later renderer invocation.
  agentAuthorityCapabilities.delete(capability);
  const projectId = payload.projectId;
  const requestId = payload.requestId;
  const toolCallId = payload.toolCallId;
  const chatMessageId = payload.chatMessageId;
  const executionId = payload.executionId;
  const mainOwnedProvenanceId = payload.mainOwnedProvenanceId;
  // The token was issued from the public model input. Re-project the native
  // payload back onto that public shape for the identity check; hashing the
  // effective native projection would include renderer-only defaults and
  // reject legitimate create_event/create_foreshadow calls.
  const inputDigest = canonicalAgentToolInputDigest(
    record.toolName,
    payload,
    false,
    "model",
    "effective",
  );
  const matches =
    record.senderId === senderId &&
    record.command === cmd &&
    projectId === record.projectId &&
    requestId === record.requestId &&
    toolCallId === record.toolCallId &&
    chatMessageId === record.chatMessageId &&
    executionId === record.executionId &&
    mainOwnedProvenanceId === record.mainOwnedProvenanceId &&
    inputDigest === record.canonicalInputDigest;
  if (!matches) return null;
  if (
    !agentMutationProjectionMatches(record.toolName, record.modelInput, payload)
  ) {
    return null;
  }
  return bindMainOwnedAgentMutation(payload, record) ? record : null;
}

function authorityRouteForUnambiguousOrigin(
  origin: unknown,
  allowedRoutes?: readonly CanonicalAuthorityRoute[],
): CanonicalAuthorityRoute | undefined {
  const route = (() => {
    switch (origin) {
      case "human":
        return "human-direct";
      case "import":
        return "import-apply";
      case "undo":
      case "redo":
        return "history-replay";
      case "restore":
      case "migration":
        return "restore-or-migration";
      default:
        return undefined;
    }
  })();
  return route && (!allowedRoutes || allowedRoutes.includes(route))
    ? route
    : undefined;
}

export type ExtraShellHandlers =
  | ShellCommandHandlers
  | ((win: BrowserWindow | null) => ShellCommandHandlers);

const WORKSPACE_OPEN_TRACE_ENV = "GRIMODEX_WORKSPACE_OPEN_TRACE";

function workspaceOpenTraceEnabled(cmd: unknown): boolean {
  return (
    cmd === "open_workspace" && process.env[WORKSPACE_OPEN_TRACE_ENV] === "1"
  );
}

function logWorkspaceOpenMainTrace(
  startedAt: number,
  result: "success" | "failure",
): void {
  try {
    console.info("[workspace-open-main]", {
      version: 1,
      result,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
  } catch {
    // Development diagnostics must never replace the existing IPC outcome.
  }
}

function isRecord(value: unknown): value is CommandArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHistoryReplayCommand(cmd: string, payload: CommandArgs): boolean {
  return (
    HISTORY_REPLAY_COMMANDS.has(cmd) ||
    cmd === "ai_tree_plan_undo" ||
    (cmd === "ai_tree_plan_apply" && payload.redo === true)
  );
}

function historyJournalIdForRendererCommand(
  cmd: string,
  payload: CommandArgs,
): unknown {
  return cmd === "agent_apply_undo_journal"
    ? payload.journalId
    : payload.undoJournalId;
}

function authorityRouteForRendererCommand(
  cmd: string,
  payload: CommandArgs,
): CanonicalAuthorityRoute | undefined {
  // Every Agent mutation is a capability-bound interactive command. Never
  // derive an Agent route from renderer-controlled origin/surface metadata.
  if (isHistoryReplayCommand(cmd, payload)) {
    return "history-replay";
  }
  if (AGENT_AUTHORITY_COMMANDS.has(cmd)) {
    return "interactive-agent-command";
  }

  if (
    CODEX_RENDERER_COMMANDS.has(cmd) ||
    RENDERER_CHRONICLE_COMMANDS.has(cmd)
  ) {
    return authorityRouteForUnambiguousOrigin(payload.origin, [
      "human-direct",
      "import-apply",
      "history-replay",
      "restore-or-migration",
    ]);
  }

  if (
    cmd === "foreshadow_create" ||
    cmd === "foreshadow_update" ||
    cmd === "foreshadow_delete"
  ) {
    return authorityRouteForUnambiguousOrigin(payload.origin, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }

  if (cmd === "foreshadow_update_setup") {
    return authorityRouteForUnambiguousOrigin(payload.origin, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }

  if (cmd === "foreshadow_setup_create_ai") {
    // This command is itself the explicit Interactive Agent surface. The
    // route is selected by the trusted command contract, never inferred from
    // the ambiguous ai-apply origin.
    if (payload.origin === "ai-apply") return "interactive-agent-command";
    return authorityRouteForUnambiguousOrigin(payload.origin, ["human-direct"]);
  }

  if (GENERIC_CANONICAL_WRITER_COMMANDS.has(cmd)) {
    return authorityRouteForUnambiguousOrigin(
      payload.origin,
      cmd === "snippet_create"
        ? ["human-direct", "import-apply", "restore-or-migration"]
        : ["human-direct"],
    );
  }

  if (HUMAN_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd)) {
    return payload.origin === "human" ? "human-direct" : undefined;
  }

  if (
    cmd !== "tree_node_create" &&
    cmd !== "tree_node_patch" &&
    cmd !== "tree_node_delete"
  ) {
    return undefined;
  }

  switch (payload.origin) {
    case "human":
      return "human-direct";
    case "import":
      return cmd === "tree_node_delete" ? undefined : "import-apply";
    case "undo":
    case "redo":
      return "history-replay";
    case "restore":
    case "migration":
      return "restore-or-migration";
    default:
      // In particular, an interactive-agent payload cannot reuse a tree
      // renderer command. AI tree plans have their own command contract.
      return undefined;
  }
}

/**
 * Main-process trust boundary for canonical renderer writers. The preload
 * bridge intentionally remains a generic transport; this function is the
 * policy binding that prevents a renderer payload from selecting an arbitrary
 * allowlisted caller/route/control set before it reaches dispatchInvoke.
 */
export function bindRendererAuthorityForIpc(
  cmd: string,
  args: CommandArgs,
  senderId?: number,
): CommandArgs {
  const directPayloadCommand = cmd === "foreshadow_setup_create_ai";
  const payloadKey =
    cmd === "foreshadow_update" || cmd === "foreshadow_update_setup"
      ? "patch"
      : "payload";
  const payload = directPayloadCommand ? args : args[payloadKey];
  if (!isRecord(payload)) return args;
  const route = authorityRouteForRendererCommand(cmd, payload);
  if (!route) {
    const requiresAuthority =
      GENERIC_CANONICAL_WRITER_COMMANDS.has(cmd) ||
      CODEX_RENDERER_COMMANDS.has(cmd) ||
      RENDERER_CHRONICLE_COMMANDS.has(cmd) ||
      HUMAN_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd) ||
      AGENT_AUTHORITY_COMMANDS.has(cmd) ||
      cmd === "foreshadow_create" ||
      cmd === "foreshadow_update" ||
      cmd === "foreshadow_delete" ||
      cmd === "tree_node_create" ||
      cmd === "tree_node_patch" ||
      cmd === "tree_node_delete" ||
      cmd === "ai_tree_plan_apply" ||
      cmd === "ai_tree_plan_undo" ||
      isHistoryReplayCommand(cmd, payload);
    if (!requiresAuthority) return args;
    const invalidPayload = { ...payload, authorityRoute: "" };
    return directPayloadCommand
      ? invalidPayload
      : { ...args, [payloadKey]: invalidPayload };
  }
  let payloadForBinding = payload;
  if (typeof senderId === "number" && Number.isInteger(senderId)) {
    if (isHistoryReplayCommand(cmd, payload)) {
      const projectId = payload.projectId;
      const journalId = historyJournalIdForRendererCommand(cmd, payload);
      if (
        !isNonEmptyTrimmedString(projectId) ||
        !isNonEmptyTrimmedString(journalId) ||
        !hasRendererHistoryJournal(senderId, projectId, journalId)
      ) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
    }
    if (
      route === "interactive-agent-command" &&
      AGENT_AUTHORITY_COMMANDS.has(cmd)
    ) {
      const capability = consumeAgentAuthorityCapability(
        cmd,
        payload,
        senderId,
      );
      if (!capability) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
      // Re-bind the provenance and the complete effective mutation after the
      // one-shot capability has been validated. Renderer values are compared
      // above, then replaced with exact main-issued identities before Native
      // sees the payload.
      const mainOwnedPayload = bindMainOwnedAgentMutation(payload, capability);
      if (!mainOwnedPayload) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
      payloadForBinding = mainOwnedPayload;
    }
    const authoritySession =
      rendererAuthoritySessions.get(senderId) ?? randomUUID();
    rendererAuthoritySessions.set(senderId, authoritySession);
  }
  const boundPayload = bindCanonicalAuthorityContext(payloadForBinding, route);
  if (HISTORY_REPLAY_COMMANDS.has(cmd)) {
    // The replay direction is part of the typed request, but the route,
    // caller, and controls are Main-owned. This prevents a renderer from
    // self-attesting a different history actor or a copied control list.
    if (payload.direction === "undo" || payload.direction === "redo") {
      boundPayload.origin = payload.direction;
    }
    boundPayload.caller = "undo-redo-command";
  }
  if (typeof senderId === "number" && Number.isInteger(senderId)) {
    {
      const authoritySession = rendererAuthoritySessions.get(senderId);
      if (!authoritySession) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
      boundPayload.authoritySessionId = authoritySession;
    }
  }
  if (typeof boundPayload.sessionId === "string") {
    boundPayload.writerSessionId = boundPayload.sessionId;
  }
  if (cmd === "tree_node_patch" && isRecord(boundPayload.changeEvent)) {
    // `changeEvent` is part of the typed tree patch, but its identity is not a
    // second authority boundary. Reconstruct the nested event from the
    // canonical top-level identity after sender binding so a copied renderer
    // payload cannot leave two writer identities in one mutation.
    boundPayload.changeEvent = {
      ...boundPayload.changeEvent,
      eventUid: boundPayload.eventUid,
      sessionId: boundPayload.sessionId,
    };
  }
  if (
    route === "history-replay" &&
    cmd.startsWith("foreshadow_") &&
    (typeof boundPayload.undoJournalId !== "string" ||
      boundPayload.undoJournalId.trim().length === 0)
  ) {
    // Typed Foreshadow inverses (for example create -> delete) may allocate
    // their new journal inside Native. Reserve an opaque lineage id at the
    // main boundary so the strict route is complete before dispatch.
    boundPayload.undoJournalId = randomUUID();
  }
  if (cmd === "ai_tree_plan_apply" && payload.redo === true) {
    boundPayload.origin = "redo";
  }
  return directPayloadCommand
    ? boundPayload
    : {
        ...args,
        [payloadKey]: boundPayload,
      };
}

/**
 * app ready 後に 1 回だけ呼ぶ。`backend` は .node ロード失敗時 null
 * （napi コマンドは IPC_BACKEND_UNAVAILABLE の明示エラーで落ちる）。
 * `extraShellHandlers` は per-invoke に再生成できないステートフルな main-TS
 * コマンド（external_mount の registry/watcher など）を単一インスタンスから
 * 注入するための拡張点。invoke ごとの `buildShellCommandHandlers` の結果へ
 * merge する（キー衝突なし = 追加分のみ）。
 * `broadcast` はmanual license mutationの返却DTOを全窓へ即時同期する窓口。
 */
export function registerIpcRouter(
  backend: NapiBackendLike | null,
  extraShellHandlers: ExtraShellHandlers = {},
  secrets?: SecretsResolver,
  broadcast?: (channel: string, payload: unknown) => void,
  narrativeMaintenanceCiSeam: NarrativeMaintenanceCiSeam = { active: false },
): void {
  ipcMain.handle(
    IPC.invoke,
    async (event, cmd: unknown, args: unknown): Promise<Envelope> => {
      const workspaceOpenStartedAt = workspaceOpenTraceEnabled(cmd)
        ? performance.now()
        : null;
      let workspaceOpenResult: "success" | "failure" = "failure";
      try {
        if (typeof cmd !== "string") {
          return {
            ok: false,
            error: "IPC_INVALID_REQUEST: command name must be a string",
          };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const injectedHandlers =
          typeof extraShellHandlers === "function"
            ? extraShellHandlers(win)
            : extraShellHandlers;
        const rawArgs = isRecord(args) ? args : {};
        const boundArgs = bindRendererAuthorityForIpc(
          cmd,
          rawArgs,
          event.sender.id,
        );
        const envelope = await dispatchInvoke(
          cmd,
          boundArgs,
          {
            backend,
            shell: { ...buildShellCommandHandlers(win), ...injectedHandlers },
            secrets,
            broadcast,
            issueAgentAuthorityCapabilities: (agentArgs, response) =>
              issueAgentAuthorityCapabilitiesForSender(
                event.sender.id,
                agentArgs,
                response,
                backend,
              ),
          },
        );
        if (
          narrativeMaintenanceCiSeam.active &&
          narrativeMaintenanceCiSeam.trigger === "foreground-workspace-wake" &&
          narrativeMaintenanceCiSeam.productJourneyBarrierId !== null &&
          narrativeMaintenanceCiSeam.correlation !== null &&
          envelope.ok &&
          cmd === "tree_node_patch"
        ) {
          const payload = isRecord(boundArgs.payload)
            ? boundArgs.payload
            : boundArgs;
          if (isNonEmptyTrimmedString(payload.projectId)) {
            scheduleNarrativeMaintenanceForegroundRelease(
              backend,
              payload.projectId,
            );
          }
        }
        if (
          envelope.ok &&
          HISTORY_JOURNAL_WRITER_COMMANDS.has(cmd) &&
          isRecord(envelope.value)
        ) {
          const payload = isRecord(boundArgs.payload)
            ? boundArgs.payload
            : boundArgs;
          const projectId = payload.projectId;
          const journalId = envelope.value.undoJournalId;
          if (
            isNonEmptyTrimmedString(projectId) &&
            isNonEmptyTrimmedString(journalId)
          ) {
            recordRendererHistoryJournalForIpc(
              event.sender.id,
              projectId,
              journalId,
            );
          }
        }
        workspaceOpenResult = envelope.ok ? "success" : "failure";
        if (!envelope.ok) {
          if (envelope.error.startsWith(IPC_UNIMPLEMENTED_MARKER)) {
            console.warn("[grim:invoke] IPC_UNIMPLEMENTED");
          } else if (
            envelope.error.startsWith(IPC_BACKEND_UNAVAILABLE_MARKER)
          ) {
            console.warn("[grim:invoke] IPC_BACKEND_UNAVAILABLE");
          }
        }
        return envelope;
      } finally {
        if (workspaceOpenStartedAt !== null) {
          logWorkspaceOpenMainTrace(
            workspaceOpenStartedAt,
            workspaceOpenResult,
          );
        }
      }
    },
  );

  // パネル別窓（§6.5、S7）の実体を注入する（shellCommands は windows.ts に
  // 直接依存しない — PanelWindowDelegate のコメント参照）。
  registerShellBridgeHandlers({
    open: openPanelWindow,
    focusByLabel: focusPanelWindow,
    existsByLabel: hasPanelWindow,
  });
}
