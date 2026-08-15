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

const GENERIC_CANONICAL_WRITER_COMMANDS = new Set([
  "snippet_create",
  "snippet_update",
  "snippet_delete",
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

// The renderer-provided recorder session is input, not authority. Keep a
// main-owned session capability per WebContents and replace the session on
// every canonical writer payload before it reaches the shared contract. This
// prevents a payload copied from another renderer window from reusing that
// window's identity while preserving one stable session for retries.
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
}

const AGENT_AUTHORITY_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const agentAuthorityCapabilities = new Map<
  string,
  AgentAuthorityCapabilityRecord
>();

const AGENT_TOOL_COMMANDS: Readonly<
  Record<string, { command: string; policy: AgentAuthorityPolicy }>
> = {
  create_codex_entry: { command: "agent_codex_create", policy: "knowledgeWrite" },
  update_codex_entry: { command: "agent_codex_update", policy: "knowledgeWrite" },
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
  apply_ai_tree_plan: { command: "ai_tree_plan_apply", policy: "structureWrite" },
  propose_scene_body: {
    command: "agent_propose_scene_body",
    policy: "bodyWrite",
  },
};
const AGENT_AUTHORITY_COMMANDS = new Set(
  [
    ...Object.values(AGENT_TOOL_COMMANDS).map(({ command }) => command),
    // These compatibility writers are still allowed to classify an AI
    // payload as interactive, so they must not become a capability bypass
    // merely because no current chat tool targets them directly.
    "agent_codex_mutate",
    ...AGENT_CHRONICLE_COMMANDS,
  ],
);

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
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

// This is deliberately a small, main-owned projection of the model tool
// contract. Derived renderer values (request/session/event ids, OCC versions
// resolved from the store, authorship marks, and authority metadata) are not
// part of the model's intent and therefore cannot be used to retarget a grant.
const AGENT_TOOL_INPUT_SPECS: Readonly<Record<string, AgentToolInputSpec>> = {
  create_codex_entry: {
    fields: ["type", "name", "summary", "content", "aliases", "parentId"],
    aliases: { type: "typeSlug" },
  },
  update_codex_entry: {
    fields: ["id", "name", "summary", "content", "aliases"],
    aliases: { id: "entryId" },
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
  set_event_participants: {
    fields: ["eventId", "codexEntryIds"],
  },
  add_event_relation: {
    fields: ["causeEventId", "effectEventId"],
  },
  remove_event_relation: {
    fields: ["causeEventId", "effectEventId"],
  },
  apply_ai_tree_plan: { fields: ["kind", "ops"] },
  propose_scene_body: {
    fields: ["sceneId", "text", "mode"],
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
    kind: "generic",
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
  propose_scene_body: { mode: "append" },
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

function plainTextFromRichText(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  const markdown = value
    .replace(/\r\n?/g, "\n")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_)/g, "");
  try {
    const parsed: unknown = JSON.parse(value);
    const text: string[] = [];
    const visit = (node: unknown): void => {
      if (!isRecord(node)) return;
      if (typeof node.text === "string") text.push(node.text);
      if (Array.isArray(node.content)) node.content.forEach(visit);
    };
    visit(parsed);
    if (text.length > 0) return text.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    // The model-facing value is Markdown, not JSON; normalize it below.
  }
  return markdown.replace(/\s+/g, " ").trim();
}

function canonicalAgentInputValue(field: string, value: unknown): unknown {
  if (field === "content") return plainTextFromRichText(value);
  if (field === "aliases" || field === "participantCodexIds" || field === "sceneIds") {
    if (Array.isArray(value)) return value.map((item) => String(item).trim());
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item).trim());
        }
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
): string | null {
  const spec = AGENT_TOOL_INPUT_SPECS[toolName];
  if (!spec || !isRecord(source)) return null;
  const defaults = AGENT_TOOL_INPUT_DEFAULTS[toolName] ?? {};
  const normalized: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const wireField = spec.aliases?.[field] ?? field;
    const raw = Object.hasOwn(source, field)
      ? source[field]
      : source[wireField];
    const value = raw === undefined ? defaults[field] : raw;
    if (value !== undefined) {
      normalized[field] = canonicalAgentInputValue(field, value);
    }
  }
  return stableCanonicalJson(normalized);
}

function canonicalAgentToolInputDigest(
  toolName: string,
  source: unknown,
): string | null {
  const canonical = canonicalAgentToolInput(toolName, source);
  if (canonical === null) return null;
  return createHash("sha256").update(canonical).digest("hex");
}

function parsePolicyAllows(raw: unknown, policy: AgentAuthorityPolicy): boolean {
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
      custom: { knowledgeWrite: false, structureWrite: false, bodyWrite: false },
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
  return response.blocks.filter(
    (block): block is Record<string, unknown> => isRecord(block),
  );
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
    const definition = AGENT_TOOL_COMMANDS[typeof toolName === "string" ? toolName : ""];
    if (!definition || !isNonEmptyTrimmedString(toolCallId) || !isNonEmptyTrimmedString(toolName)) {
      continue;
    }
    if (!(await policyAllowsAgentTool(backend, projectId, definition.policy))) {
      continue;
    }
    const canonicalInputDigest = canonicalAgentToolInputDigest(
      toolName,
      block.input,
    );
    if (!canonicalInputDigest) continue;
    const now = Date.now();
    const token = randomUUID();
    const mainOwnedProvenanceId = randomUUID();
    agentAuthorityCapabilities.set(token, {
      senderId,
      projectId,
      toolName,
      command: definition.command,
      requestId: agentToolRequestId(toolName, projectId, toolCallId),
      toolCallId,
      policy: definition.policy,
      executionId,
      chatMessageId,
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
  const inputDigest = canonicalAgentToolInputDigest(record.toolName, payload);
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
  return matches ? record : null;
}

function authorityRouteForOrigin(
  origin: unknown,
  allowedRoutes?: readonly CanonicalAuthorityRoute[],
): CanonicalAuthorityRoute | undefined {
  const route = (() => {
    switch (origin) {
      case "human":
        return "human-direct";
      case "ai-apply":
        return "interactive-agent-command";
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

function authorityRouteForRendererCommand(
  cmd: string,
  payload: CommandArgs,
): CanonicalAuthorityRoute | undefined {
  if (
    cmd === "agent_codex_create" ||
    cmd === "agent_codex_update" ||
    cmd === "agent_codex_delete" ||
    cmd === "agent_codex_mutate"
  ) {
    return authorityRouteForOrigin(payload.origin, [
      "human-direct",
      "interactive-agent-command",
    ]);
  }

  if (
    cmd === "agent_foreshadow_create" ||
    cmd === "agent_foreshadow_update" ||
    cmd === "agent_snippet_create" ||
    cmd === "agent_propose_scene_body"
  ) {
    return "interactive-agent-command";
  }

  if (AGENT_CHRONICLE_COMMANDS.has(cmd)) {
    const origin =
      payload.origin ?? (payload.surface === "manual" ? "human" : "ai-apply");
    return authorityRouteForOrigin(
      origin,
      cmd === "agent_chronicle_bulk_mutate"
        ? ["human-direct", "interactive-agent-command"]
        : ["human-direct", "interactive-agent-command", "import-apply"],
    );
  }

  if (
    cmd === "foreshadow_create" ||
    cmd === "foreshadow_update" ||
    cmd === "foreshadow_delete"
  ) {
    return authorityRouteForOrigin(payload.origin, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }

  if (cmd === "foreshadow_update_setup") {
    return authorityRouteForOrigin(payload.origin, [
      "human-direct",
      "history-replay",
      "restore-or-migration",
    ]);
  }

  if (cmd === "foreshadow_setup_create_ai") {
    return authorityRouteForOrigin(payload.origin, [
      "human-direct",
      "interactive-agent-command",
    ]);
  }

  if (GENERIC_CANONICAL_WRITER_COMMANDS.has(cmd)) {
    return authorityRouteForOrigin(
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
    cmd === "ai_tree_plan_apply" ||
    cmd === "ai_tree_plan_undo"
  ) {
    return cmd === "ai_tree_plan_undo" || payload.redo === true
      ? "history-replay"
      : "interactive-agent-command";
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
      HUMAN_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd) ||
      AGENT_CHRONICLE_COMMANDS.has(cmd) ||
      cmd === "agent_codex_create" ||
      cmd === "agent_codex_update" ||
      cmd === "agent_codex_delete" ||
      cmd === "agent_codex_mutate" ||
      cmd === "agent_foreshadow_create" ||
      cmd === "agent_foreshadow_update" ||
      cmd === "agent_snippet_create" ||
      cmd === "agent_propose_scene_body" ||
      cmd === "foreshadow_create" ||
      cmd === "foreshadow_update" ||
      cmd === "foreshadow_delete" ||
      cmd === "tree_node_create" ||
      cmd === "tree_node_patch" ||
      cmd === "tree_node_delete" ||
      cmd === "ai_tree_plan_apply" ||
      cmd === "ai_tree_plan_undo";
    if (!requiresAuthority) return args;
    const invalidPayload = { ...payload, authorityRoute: "" };
    return directPayloadCommand
      ? invalidPayload
      : { ...args, [payloadKey]: invalidPayload };
  }
  let payloadForBinding = payload;
  if (typeof senderId === "number" && Number.isInteger(senderId)) {
    if (
      route === "interactive-agent-command" &&
      AGENT_AUTHORITY_COMMANDS.has(cmd)
    ) {
      const capability = consumeAgentAuthorityCapability(cmd, payload, senderId);
      if (!capability) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
      // Re-bind the provenance after the one-shot capability has been
      // validated. Renderer values are compared above, then replaced with the
      // exact main-issued identities before Native sees the payload.
      payloadForBinding = {
        ...payload,
        executionId: capability.executionId,
        mainOwnedProvenanceId: capability.mainOwnedProvenanceId,
        chatMessageId: capability.chatMessageId,
        toolCallId: capability.toolCallId,
        traceId: capability.mainOwnedProvenanceId,
      };
    }
    const authoritySession =
      rendererAuthoritySessions.get(senderId) ?? randomUUID();
    rendererAuthoritySessions.set(senderId, authoritySession);
  }
  const boundPayload = bindCanonicalAuthorityContext(payloadForBinding, route);
  if (typeof senderId === "number" && Number.isInteger(senderId)) {
    {
      const authoritySession = rendererAuthoritySessions.get(senderId);
      if (!authoritySession) {
        const invalidPayload = { ...payload, authorityRoute: "" };
        return directPayloadCommand
          ? invalidPayload
          : { ...args, [payloadKey]: invalidPayload };
      }
      boundPayload.sessionId = authoritySession;
    }
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
        const envelope = await dispatchInvoke(
          cmd,
          bindRendererAuthorityForIpc(cmd, rawArgs, event.sender.id),
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
