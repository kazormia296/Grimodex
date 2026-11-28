/**
 * invoke ルーター（設計書 §2 / §5.2、Phase 2 S4）。
 *
 * `ipcMain.handle("grim:invoke")` 1 本に集約し、ルーティングの実体は
 * 純関数 `dispatchInvoke`（electron/shared/ipcContract.ts — node 環境で
 * 単体テスト済み）へ委譲する。ここは electron グルーのみ:
 * - 送信元窓の解決（保存ダイアログなど窓単位コマンドへの束縛）
 * - fail-soft outcome の main 側ログ（A6 監査の集計ポイント）
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";

import {
  bindCanonicalAuthorityContext,
  D2A_DB_OWN_DATA_READ,
  dispatchInvoke,
  IPC,
  IPC_BACKEND_UNAVAILABLE_MARKER,
  IPC_UNIMPLEMENTED_MARKER,
  isNir1LocalGenerationCommand,
  toErrorString,
} from "../shared/ipcContract.js";
import { classifyAiPolicy } from "../shared/aiPolicy/classifyAiPolicy.js";
import {
  hasMastraAgentTurnForbiddenKey,
  isMastraAgentTurnCommand,
  MASTRA_AGENT_TURN_ANSWER_COMMAND,
  mastraAgentTurnRefusalValue,
} from "../shared/mastraAgentTurnWire.js";
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
import {
  claimNarrativeMaintenanceForegroundRelease,
  normalizeWorkspaceBinding,
  scheduleNarrativeMaintenanceForegroundRelease,
} from "./narrativeMaintenance.js";
import type { NarrativeMaintenanceCiSeam } from "./narrativeMaintenanceCiSeam.js";
import type { LicenseValidationScheduler } from "./licenseValidation.js";
import { createRelatedScenesSearchAuthority } from "./relatedScenesSearchAuthority.js";
import {
  MAIN_GRANT_REQUIRED,
  isGrantRequiredCommand,
  stripRendererGrantFields,
  type MainGrantController,
} from "./mainGrant.js";
import { createRelatedScenesReconciler } from "./relatedScenesReconciler.js";
import type { ProfileActivationController } from "./profileActivation.js";
import type { AiStreamTerminalTracker } from "./aiStreamTerminals.js";
import {
  createNir1LocalGenerationRoute,
  parseNir1LocalGenerationCiSeam,
  startNir1LocalGenerationCiSeam,
  type Nir1LocalGenerationLaunch,
} from "./nir1LocalGeneration.js";
import { chatAgentIrGateRefusal } from "./chatAgentIr.js";
import {
  AGENT_APPROVAL_VERSIONED_TOOLS,
  type AgentApprovalApprovedTarget,
  agentTreePlanRequiresVersion,
} from "./agentApprovalProtectedTools.js";
import {
  createMastraAgentTurnRoute,
  openMastraAgentTurnGate,
  parseMastraAgentTurnCiSeam,
} from "./mastraAgentTurnGate.js";
import { defaultUserDataDirectoriesForApp } from "./userData.js";
import { mastraOriginalEnv } from "./mastraEnv.js";
import type {
  MastraTurnOwner,
  MastraTurnSwitchLease,
} from "./mastraTurnOwner.js";
import {
  PROFILE_ACTIVATION_REQUEST_COMMAND,
  PROFILE_EGRESS_STATUS_COMMAND,
} from "../shared/profileEgressStatusWire.js";
import type {
  MainIssuedCallerIdentity,
  ProfileEgressGate,
} from "./profileEgress.js";
import type {
  NarrativeMaintenanceQuiesceLease,
  NarrativeMaintenanceScheduler,
} from "./narrativeMaintenance.js";
import type {
  NarrativeFreshnessQuiesceLease,
  NarrativeFreshnessScheduler,
} from "./narrativeFreshness.js";
import {
  AGENT_TOOL_INPUT_DEFAULTS,
  applyMainOwnedAuthorshipMarks,
  agentToolInputDigest,
  canonicalAgentInputValue,
  canonicalAgentToolInput,
  canonicalAgentToolInputDigest,
  EFFECTIVE_NATIVE_MUTATION_SPECS,
  isRecord,
  isAgentEventSecretInputSupported,
  isAgentForeshadowSecretInputSupported,
  stableCanonicalJson,
  type AgentToolInputProjection,
  type AgentToolInputSpec,
} from "./agentToolInputDigest.js";
export {
  applyMainOwnedAuthorshipMarks,
  agentToolInputDigest,
  canonicalAgentToolInputDigest,
} from "./agentToolInputDigest.js";
export type { MainOwnedAuthorshipMarkAttrs } from "./agentToolInputDigest.js";

const GENERIC_CANONICAL_WRITER_COMMANDS = new Set([
  "snippet_create",
  "snippet_update",
  "snippet_delete",
]);

const MANUAL_LICENSE_COMMANDS = new Set([
  "activate_license",
  "revalidate_license",
  "deactivate_license",
]);

const WORKSPACE_SWITCH_COMMANDS = new Set([
  "open_workspace",
  "restore_backup",
  "restore_recovery_candidate",
]);

const MANUAL_NARRATIVE_MAINTENANCE_COMMANDS = new Set([
  "verify_narrative_dependency_graph",
  "rebuild_narrative_derived_state",
]);

// Scan publication is an import-only canonical writer. Keep it out of the
// generic renderer writer set so a forged human/AI origin cannot select a
// different authority route at the main boundary.
const IMPORT_ONLY_CANONICAL_WRITER_COMMANDS = new Set([
  "scan_staging_project_publish",
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
  // entity_tags_set stays in this set so that an origin without a route is
  // still blanked (bound) below; authorityRouteForRendererCommand gives it
  // import-apply as well, before the human-only branch.
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

// These immutable revisions are human-only but never create undo journals.
const IDENTITY_CORRECTION_RULE_WRITER_COMMANDS = new Set([
  "identity_correction_rule_create",
  "identity_correction_rule_supersede",
  "identity_correction_rule_retire",
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

export type AgentAuthorityPolicy =
  | "knowledgeWrite"
  | "structureWrite"
  | "bodyWrite";

export interface AgentAuthorityCapabilityRecord {
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
  readonly origin?: "approval-exchange";
  readonly approvedTarget?: AgentApprovalApprovedTarget;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface AgentAuthorityCapabilityGrant {
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

export const AGENT_TOOL_COMMANDS: Readonly<
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
  "agent_codex_delete",
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

const RELATED_SCENES_MUTATION_WAKE_COMMANDS = new Set([
  ...HISTORY_JOURNAL_WRITER_COMMANDS,
  "narrative_extraction_save_proposal_set",
  "nir1_entity_relation_revision_create",
  "nir1_entity_relation_revision_prepare",
  "narrative_extraction_create_human_derived_revision",
  "narrative_extraction_append_revision",
  "narrative_extraction_append_decision",
  "narrative_extraction_append_human_decision",
  "narrative_extraction_chronicle_bulk_approve",
  "narrative_extraction_reapprove_applied_proposals",
  "narrative_extraction_revise_and_decide",
  "narrative_extraction_revise_and_decide_as_human",
  "narrative_extraction_apply_commit",
  "narrative_extraction_undo_commit",
  "narrative_extraction_redo_commit",
  "semantic_cancel_background",
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

function postprocessSuccessfulWriter(
  cmd: string,
  args: CommandArgs,
  value: unknown,
  senderId: number,
  wakeRelatedScenes: () => void,
): void {
  if (RELATED_SCENES_MUTATION_WAKE_COMMANDS.has(cmd)) wakeRelatedScenes();
  if (!HISTORY_JOURNAL_WRITER_COMMANDS.has(cmd) || !isRecord(value)) return;
  const payload = isRecord(args.payload) ? args.payload : args;
  const projectId = payload.projectId;
  const journalId = value.undoJournalId;
  if (
    isNonEmptyTrimmedString(projectId) &&
    isNonEmptyTrimmedString(journalId)
  ) {
    recordRendererHistoryJournalForIpc(senderId, projectId, journalId);
  }
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim()
  );
}

export function agentAuthorityRequestId(
  toolName: string,
  projectId: string,
  toolCallId: string,
): string {
  const digest = createHash("sha256")
    .update(`${toolName}\0${projectId}\0${toolCallId}`)
    .digest("hex");
  return `agent-tool:${digest}`;
}

export interface PrepareAgentAuthorityCapabilityInput {
  readonly senderId: number;
  readonly projectId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly executionId: string;
  readonly chatMessageId: string;
  readonly model: string | null;
  readonly modelInput: Record<string, unknown>;
  readonly canonicalInputDigest: string;
  readonly ttlMs: number;
  readonly origin?: "approval-exchange";
  readonly approvedTarget?: AgentApprovalApprovedTarget;
}

/** Builds an inactive capability; activate() issues it and revoke() removes it. */
export function prepareAgentAuthorityCapability(
  input: PrepareAgentAuthorityCapabilityInput,
): {
  readonly grant: AgentAuthorityCapabilityGrant;
  activate(): void;
  revoke(): void;
} | null {
  const definition = AGENT_TOOL_COMMANDS[input.toolName];
  if (!definition || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    return null;
  }
  const token = randomUUID();
  const requestId = agentAuthorityRequestId(
    input.toolName,
    input.projectId,
    input.toolCallId,
  );
  const expectedEntityId = mainOwnedEntityId(input.toolName, requestId);
  const mainOwnedProvenanceId = randomUUID();
  const grant: AgentAuthorityCapabilityGrant = {
    capability: token,
    executionId: input.executionId,
    chatMessageId: input.chatMessageId,
    mainOwnedProvenanceId,
    ...(expectedEntityId ? { expectedEntityId } : {}),
  };
  const record = {
    senderId: input.senderId,
    projectId: input.projectId,
    toolName: input.toolName,
    command: definition.command,
    requestId,
    toolCallId: input.toolCallId,
    policy: definition.policy,
    executionId: input.executionId,
    chatMessageId: input.chatMessageId,
    model: input.model,
    modelInput: cloneJsonRecord(input.modelInput),
    expectedEntityId,
    canonicalInputDigest: input.canonicalInputDigest,
    mainOwnedProvenanceId,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.approvedTarget !== undefined
      ? {
          approvedTarget: {
            baseVersions:
              input.approvedTarget.baseVersions?.map((entry) => ({
                id: entry.id,
                version: entry.version,
              })) ?? null,
            expected: input.approvedTarget.expected
              ? { ...input.approvedTarget.expected }
              : null,
          },
        }
      : {}),
  };
  let activated = false;
  let revoked = false;
  return {
    grant,
    activate() {
      if (activated || revoked) return;
      const issuedAt = Date.now();
      pruneAgentAuthorityCapabilities(issuedAt);
      agentAuthorityCapabilities.set(token, {
        ...record,
        issuedAt,
        expiresAt: issuedAt + input.ttlMs,
      });
      activated = true;
    },
    revoke() {
      revoked = true;
      agentAuthorityCapabilities.delete(token);
    },
  };
}

function parsePolicyAllows(
  raw: unknown,
  policy: AgentAuthorityPolicy,
): boolean {
  // NULL は新しい作品の既定（bodyWrite だけ可）。読めない値・壊れた値は 3 軸とも不可。
  return classifyAiPolicy(raw).toggles[policy];
}

function pruneAgentAuthorityCapabilities(now = Date.now()): void {
  for (const [token, record] of agentAuthorityCapabilities) {
    if (record.expiresAt <= now) agentAuthorityCapabilities.delete(token);
  }
}

const UNREADABLE_POLICY_ROW = Symbol("unreadable-policy-row");

/**
 * Native `db_execute` returns each row as an object (column name -> value;
 * `grimodex-db` `execute_impl`), so the object branch is the real path. The
 * positional array branch is never produced by Native; it exists only for
 * compatibility with test mocks (main does not receive array rows from
 * Native). Anything else, or an object without the `ai_policy` column, is
 * unreadable (fail closed by the caller).
 */
function aiPolicyColumn(row: unknown): unknown {
  if (Array.isArray(row)) {
    return row.length >= 1 ? row[0] : UNREADABLE_POLICY_ROW;
  }
  if (isRecord(row) && Object.hasOwn(row, "ai_policy")) {
    return row.ai_policy;
  }
  return UNREADABLE_POLICY_ROW;
}

async function policyAllowsAgentTool(
  backend: NapiBackendLike,
  projectId: string,
  policy: AgentAuthorityPolicy,
  callerIdentity?: MainIssuedCallerIdentity,
): Promise<boolean> {
  const raw =
    callerIdentity === undefined
      ? await backend.dbExecute(
          "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
          [projectId],
          "get",
        )
      : await backend.dbExecute(
          "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
          [projectId],
          "get",
          JSON.stringify(callerIdentity),
        );
  const parsed = JSON.parse(raw) as { rows?: unknown };
  const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  // A missing row or more than one row is a broken answer, not a policy.
  if (rows.length !== 1) return false;
  const column = aiPolicyColumn(rows[0]);
  // A row whose shape cannot be read is never treated as a NULL policy: that
  // would grant the NULL default to a project whose real policy is unknown.
  if (column === UNREADABLE_POLICY_ROW) return false;
  return parsePolicyAllows(column, policy);
}

/** Reads the tool's current policy axis and fails closed when the tool is unknown. */
export async function isAgentToolPolicyAllowed(
  backend: NapiBackendLike,
  projectId: string,
  toolName: string,
  callerIdentity?: MainIssuedCallerIdentity,
): Promise<boolean> {
  const definition = AGENT_TOOL_COMMANDS[toolName];
  return definition
    ? policyAllowsAgentTool(
        backend,
        projectId,
        definition.policy,
        callerIdentity,
      )
    : false;
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
    !isAgentEventSecretInputSupported(toolName, modelInput) ||
    !isAgentForeshadowSecretInputSupported(toolName, modelInput) ||
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

function approvedVersionForAgentTarget(
  id: unknown,
  versions: readonly { readonly id: string; readonly version: number }[],
): number | null {
  if (!isNonEmptyTrimmedString(id)) return null;
  const matches = versions.filter((entry) => entry.id === id);
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(matches[0]?.version) ||
    (matches[0]?.version ?? -1) < 0
  ) {
    return null;
  }
  return matches[0]!.version;
}

function bindApprovedAgentTarget(
  bound: CommandArgs,
  capability: AgentAuthorityCapabilityRecord,
): boolean {
  if (capability.origin !== "approval-exchange") return true;
  const approvedTarget = capability.approvedTarget;
  if (!approvedTarget) return false;
  const expected = approvedTarget.expected;
  delete bound.expected;
  if (expected !== null) {
    if (
      ((capability.toolName === "stamp_scene_event" ||
        capability.toolName === "unstamp_scene_event") &&
        expected.kind !== "scene_event_link") ||
      ((capability.toolName === "add_event_relation" ||
        capability.toolName === "remove_event_relation") &&
        expected.kind !== "event_relation") ||
      !(
        capability.toolName === "stamp_scene_event" ||
        capability.toolName === "unstamp_scene_event" ||
        capability.toolName === "add_event_relation" ||
        capability.toolName === "remove_event_relation"
      )
    ) {
      return false;
    }
    // Native の期待状態の欄だけを渡す。kind は main の中の区別で、Native は未知の欄を拒む。
    const nativeExpected: Record<string, unknown> = { ...expected };
    delete nativeExpected.kind;
    bound.expected = nativeExpected;
  } else if (
    capability.toolName === "stamp_scene_event" ||
    capability.toolName === "unstamp_scene_event" ||
    capability.toolName === "add_event_relation" ||
    capability.toolName === "remove_event_relation"
  ) {
    return false;
  }
  const versions = approvedTarget.baseVersions;
  const treePlanVersionRequirement =
    capability.toolName === "apply_ai_tree_plan"
      ? agentTreePlanRequiresVersion(capability.modelInput.ops)
      : null;
  if (
    capability.toolName === "apply_ai_tree_plan" &&
    treePlanVersionRequirement === null
  ) {
    return false;
  }
  const requiresVersion =
    capability.toolName !== "apply_ai_tree_plan" ||
    treePlanVersionRequirement === true;
  if (
    AGENT_APPROVAL_VERSIONED_TOOLS.has(capability.toolName) &&
    requiresVersion &&
    (!versions || versions.length === 0)
  ) {
    return false;
  }
  if (versions === null) return true;
  let requiresTargetVersion = true;
  let targetId: unknown;
  switch (capability.toolName) {
    case "update_codex_entry":
      targetId = bound.entryId ?? bound.id;
      break;
    case "update_foreshadow":
      targetId = bound.foreshadowId ?? bound.id;
      break;
    case "update_event":
    case "delete_event":
    case "set_event_participants":
      targetId = bound.eventId;
      break;
    default:
      requiresTargetVersion = false;
  }
  if (requiresTargetVersion) {
    const version = approvedVersionForAgentTarget(targetId, versions);
    if (version === null) return false;
    bound.baseVersion = version;
  }
  if (capability.toolName === "apply_ai_tree_plan") {
    if (!Array.isArray(bound.updates)) return false;
    const updates: CommandArgs[] = [];
    for (const update of bound.updates) {
      if (!isRecord(update)) return false;
      const version = approvedVersionForAgentTarget(update.id, versions);
      if (version === null) return false;
      updates.push({ ...update, baseVersion: version });
    }
    bound.updates = updates;
  }
  return true;
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
  if (!bindApprovedAgentTarget(bound, capability)) return null;
  if (
    capability.toolName === "create_event" ||
    capability.toolName === "update_event"
  ) {
    delete bound.secret;
  }
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

/** Main-only authority issuer shared by the legacy invoke and Mastra turn loop. */
export async function issueAgentAuthorityCapabilitiesForSender(
  senderId: number,
  args: CommandArgs,
  response: unknown,
  backend: NapiBackendLike | null,
  callerIdentity?: MainIssuedCallerIdentity,
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
    if (
      !(await policyAllowsAgentTool(
        backend,
        projectId,
        definition.policy,
        callerIdentity,
      ))
    ) {
      continue;
    }
    if (!isRecord(block.input)) continue;
    const canonicalInputDigest = agentToolInputDigest(toolName, block.input);
    if (!canonicalInputDigest) continue;
    const prepared = prepareAgentAuthorityCapability({
      senderId,
      projectId,
      toolName,
      toolCallId,
      executionId,
      chatMessageId,
      model: typeof args.model === "string" ? args.model : null,
      modelInput: cloneJsonRecord(block.input),
      canonicalInputDigest,
      ttlMs: AGENT_AUTHORITY_CAPABILITY_TTL_MS,
    });
    if (!prepared) continue;
    prepared.activate();
    issued[toolCallId] = prepared.grant;
  }
  if (Object.keys(issued).length === 0 || !isRecord(response)) return response;
  return { ...response, agentAuthorityCapabilities: issued };
}

/** Main-only one-shot capability consumer shared by renderer and Main writers. */
export function consumeAgentAuthorityCapability(
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

/** Consumes one grant and returns its main-bound Native payload. */
export function consumeAndBindAgentAuthorityCapability(
  cmd: string,
  payload: CommandArgs,
  senderId: number,
): CommandArgs | null {
  if (!Number.isInteger(senderId)) return null;
  const args = bindRendererAuthorityForIpc(cmd, { payload }, senderId);
  return isRecord(args.payload) &&
    args.payload.authorityRoute === "interactive-agent-command"
    ? args.payload
    : null;
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

/** index.ts は ./ の import だけを使う（rendererContainment.startupOrder の試験の前提）ので、ここから型を再 export する。 */
export type { CommandArgs };

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

const NATIVE_DB_RESULT_KIND_KEY = "__grimodexDbResultKind";
type NativeDbResultKind = "read" | "committed-mutation";

function nativeDbResultKind(
  command: string,
  value: unknown,
): NativeDbResultKind | "invalid" | null {
  if (command !== "db_execute" && command !== "db_execute_batch") {
    return null;
  }
  if (!isRecord(value) || !Object.hasOwn(value, NATIVE_DB_RESULT_KIND_KEY)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("rows") ||
    !Array.isArray(value.rows)
  ) {
    return "invalid";
  }
  if (
    value[NATIVE_DB_RESULT_KIND_KEY] === "read" ||
    value[NATIVE_DB_RESULT_KIND_KEY] === "committed-mutation"
  ) {
    return value[NATIVE_DB_RESULT_KIND_KEY];
  }
  return "invalid";
}

function stripNativeDbResultKind(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const publicValue = { ...value };
  delete publicValue[NATIVE_DB_RESULT_KIND_KEY];
  return publicValue;
}

function isOpaqueCommittedDbMutationReceipt(
  command: string,
  value: unknown,
): boolean {
  if (command !== "db_execute" && command !== "db_execute_batch") {
    return false;
  }
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("rows") &&
    keys.includes("committed") &&
    value.committed === true &&
    Array.isArray(value.rows) &&
    value.rows.length === 0
  );
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

  if (IMPORT_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd)) {
    return authorityRouteForUnambiguousOrigin(payload.origin, ["import-apply"]);
  }

  // The Codex import sets an imported entry's tags in the same import session
  // as the entry itself (importApi.ts), so the tag writer takes import-apply
  // as well as human-direct, like the other typed writers the import uses.
  if (cmd === "entity_tags_set") {
    return authorityRouteForUnambiguousOrigin(payload.origin, [
      "human-direct",
      "import-apply",
    ]);
  }

  if (IDENTITY_CORRECTION_RULE_WRITER_COMMANDS.has(cmd)) {
    return payload.origin === "human" ? "human-direct" : undefined;
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

function commandRequiresRendererAuthority(cmd: string): boolean {
  return (
    GENERIC_CANONICAL_WRITER_COMMANDS.has(cmd) ||
    IMPORT_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd) ||
    CODEX_RENDERER_COMMANDS.has(cmd) ||
    RENDERER_CHRONICLE_COMMANDS.has(cmd) ||
    HUMAN_ONLY_CANONICAL_WRITER_COMMANDS.has(cmd) ||
    IDENTITY_CORRECTION_RULE_WRITER_COMMANDS.has(cmd) ||
    AGENT_AUTHORITY_COMMANDS.has(cmd) ||
    HISTORY_REPLAY_COMMANDS.has(cmd) ||
    cmd === "foreshadow_create" ||
    cmd === "foreshadow_update" ||
    cmd === "foreshadow_delete" ||
    cmd === "tree_node_create" ||
    cmd === "tree_node_patch" ||
    cmd === "tree_node_delete" ||
    cmd === "ai_tree_plan_apply" ||
    cmd === "ai_tree_plan_undo"
  );
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
  if (!isRecord(payload)) {
    if (
      !commandRequiresRendererAuthority(cmd) &&
      cmd !== "foreshadow_update_setup"
    ) {
      return args;
    }
    const { [payloadKey]: _discardedPayload, ...remainingArgs } = args;
    return remainingArgs;
  }
  const route = authorityRouteForRendererCommand(cmd, payload);
  if (!route) {
    const requiresAuthority =
      commandRequiresRendererAuthority(cmd) ||
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
 * Release the pending Related Scenes operation of a `related_scenes_begin`
 * result the D2a completion check refused to publish (K3/2 `nir1-publication`).
 * Best effort: a failure leaves the lease to its fixed TTL and the owner
 * cleanup on sender destruction, and never reaches the renderer.
 */
function releaseUnpublishedRelatedScenesOperation(
  backend: NapiBackendLike | null | undefined,
  ownerKey: string,
  value: unknown,
): void {
  if (!isRecord(value) || !isRecord(value.ir)) return;
  const ticket = value.ir.operationTicket;
  if (typeof ticket !== "string" || !backend?.relatedScenesRelease) return;
  try {
    Promise.resolve(backend.relatedScenesRelease(ownerKey, ticket)).catch(() =>
      console.warn("[related-scenes] unpublished operation release failed"),
    );
  } catch {
    console.warn("[related-scenes] unpublished operation release failed");
  }
}

/**
 * The launch facts of the NIR-1 local generation journey seam (DR-DD1B-1),
 * read once from Electron's `app` and `process.env` when the router is
 * registered. Anything unreadable is a packaged (closed) launch; a packaged
 * launch reads no environment value (K5/3 必須防御 17).
 */
export function nir1LocalGenerationLaunchFromApp(): Nir1LocalGenerationLaunch {
  const closed: Nir1LocalGenerationLaunch = {
    isPackaged: true,
    env: {},
    userDataDir: "",
    defaultUserDataDirs: () => [],
  };
  try {
    if (app.isPackaged !== false) return closed;
    return {
      isPackaged: false,
      env: mastraOriginalEnv(),
      userDataDir: app.getPath("userData"),
      defaultUserDataDirs: () => defaultUserDataDirectoriesForApp(app),
    };
  } catch {
    return closed;
  }
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
  profileEgress?: ProfileEgressGate,
  licenseValidation?: Pick<LicenseValidationScheduler, "runManualOperation">,
  narrativeMaintenance?: Pick<
    NarrativeMaintenanceScheduler,
    | "quiesceForWorkspaceSwitch"
    | "reconcileRecoveryBeforeWorkspaceOpen"
    | "beginNarrativeMaintenanceAttempt"
    | "cancelNarrativeMaintenanceAttempt"
  >,
  narrativeFreshness?: Pick<
    NarrativeFreshnessScheduler,
    "quiesceForWorkspaceSwitch"
  >,
  mainGrant?: MainGrantController,
  profileActivation?: ProfileActivationController,
  aiStreamTerminals?: AiStreamTerminalTracker,
  /**
   * The local generation journey seam's launch facts (DR-DD1B-1). The product
   * omits it, and the router reads Electron's `app` once; tests pass it.
   */
  nir1LocalGenerationLaunch: Nir1LocalGenerationLaunch = nir1LocalGenerationLaunchFromApp(),
  /**
   * The Mastra agent turn owner (MP-3c). Optional so that the route alone can be
   * registered (tests, and 3b's shape): without it an admitted start is
   * `unsupported`. The owner holds the turns; this router holds the gate and
   * the workspace switch's lease.
   */
  mastraTurnOwner?: MastraTurnOwner,
): void {
  // NIR-1 local generation (DD-1b): Main's gate is open only when the journey
  // seam opened Native's gate at this registration (DR-DD1B-3, DR-DD1B-4).
  const nir1LocalGeneration = createNir1LocalGenerationRoute({
    open: startNir1LocalGenerationCiSeam({
      seam: parseNir1LocalGenerationCiSeam(nir1LocalGenerationLaunch),
      backend,
      isPackaged: nir1LocalGenerationLaunch.isPackaged,
    }),
    backend,
    secrets,
    profileEgress,
  });
  // Mastra agent turn (MP-3b, gate L, DR-MP3-17): Main's gate is open only for
  // the journey seam; it reads the same launch facts, once, as the seam above
  // and has no Native entry to open.
  const mastraAgentTurn = createMastraAgentTurnRoute({
    // The owner's own flag when there is one (index.ts reads the seam once and
    // the owner, the loader and this route share that answer).
    open:
      mastraTurnOwner?.open ??
      openMastraAgentTurnGate({
        seam: parseMastraAgentTurnCiSeam(nir1LocalGenerationLaunch),
        isPackaged: nir1LocalGenerationLaunch.isPackaged,
      }),
    profileEgress,
    owner: mastraTurnOwner,
  });
  const relatedScenesReconciler = createRelatedScenesReconciler({
    reconcile: async (periodic) => {
      if (!backend?.relatedScenesReconcile)
        throw new Error("RELATED_SCENES_RECONCILIATION_UNAVAILABLE");
      return JSON.parse(await backend.relatedScenesReconcile(periodic)) as {
        activeOperations: number;
      };
    },
    reportFailure: () =>
      console.warn("[related-scenes] Native generation reconciliation failed"),
  });
  if (typeof mastraTurnOwner?.setSuccessfulWriteProcessor === "function") {
    mastraTurnOwner.setSuccessfulWriteProcessor((cmd, args, value, senderId) =>
      postprocessSuccessfulWriter(cmd, args, value, senderId, () =>
        relatedScenesReconciler.wake(),
      ),
    );
  }
  const relatedScenesAuthority = createRelatedScenesSearchAuthority({
    releaseOwner: (ownerKey) => {
      relatedScenesReconciler.releaseOwner(ownerKey);
      return backend?.relatedScenesReleaseOwner?.(ownerKey);
    },
    onReleaseFailure: () =>
      console.warn("[related-scenes] Native owner cleanup failed"),
  });
  ipcMain.handle(
    IPC.invoke,
    async (event, cmd: unknown, args: unknown): Promise<Envelope> => {
      const workspaceOpenStartedAt = workspaceOpenTraceEnabled(cmd)
        ? performance.now()
        : null;
      let workspaceOpenResult: "success" | "failure" = "failure";
      let workspaceSwitchLeases: Array<
        | NarrativeMaintenanceQuiesceLease
        | NarrativeFreshnessQuiesceLease
        | MastraTurnSwitchLease
      > = [];
      try {
        if (typeof cmd !== "string") {
          return {
            ok: false,
            error: "IPC_INVALID_REQUEST: command name must be a string",
          };
        }
        // Main's gate of the local generation route comes first: while it is
        // closed nothing of the invoke (identity, D2a, key store, Native) is
        // reached (K5/3 必須防御 16).
        const nir1LocalGateRefusal = nir1LocalGeneration.gateRefusal(cmd);
        if (nir1LocalGateRefusal) return nir1LocalGateRefusal;
        // chat IR (DR-CHATIR-S1-27): closed in every launch, with no seam.
        const chatAgentIrRefusal = chatAgentIrGateRefusal(cmd);
        if (chatAgentIrRefusal) return chatAgentIrRefusal;
        // Mastra agent turn (gate L): closed in every product launch; first for
        // the same reason, nothing of the invoke is reached while it is closed.
        const mastraAgentTurnRefusal = mastraAgentTurn.gateRefusal(cmd);
        if (mastraAgentTurnRefusal) return mastraAgentTurnRefusal;
        if (
          cmd === "capture_current_chat_input" &&
          event.sender.isDestroyed()
        ) {
          return {
            ok: false,
            error: "IPC_CAPTURE_SENDER_DESTROYED: no capture was started",
          };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const injectedHandlers =
          typeof extraShellHandlers === "function"
            ? extraShellHandlers(win)
            : extraShellHandlers;
        const rawArgs = isRecord(args) ? args : {};
        const canonicalArgs = bindRendererAuthorityForIpc(
          cmd,
          rawArgs,
          event.sender.id,
        );
        const boundArgs = relatedScenesAuthority.bind(
          cmd,
          canonicalArgs,
          event.sender,
        );
        // `attemptId` is a main-issued lifecycle identity. Strip any value
        // supplied by a renderer before the profile gate and only add the
        // exact scheduler-owned id below after admission succeeds.
        // Grant-shaped fields a renderer put next to a request that needs
        // Main's one-time grant are dropped; the grant is attached only by
        // `mainGrant`, as a non-enumerable sidecar after the dialog.
        const rendererSafeArgs = isGrantRequiredCommand(cmd)
          ? stripRendererGrantFields(boundArgs)
          : MANUAL_NARRATIVE_MAINTENANCE_COMMANDS.has(cmd) &&
              isRecord(boundArgs) &&
              isRecord(boundArgs.payload)
            ? (() => {
                const { attemptId: _rendererAttemptId, ...payload } =
                  boundArgs.payload;
                return { ...boundArgs, payload };
              })()
            : boundArgs;
        // The Mastra turn route refuses a renderer that sends a key that is
        // Main's (the identity below replaces `callerIdentity`, so it is read
        // here, before that).
        const mastraForgedKey =
          (isMastraAgentTurnCommand(cmd) ||
            cmd === MASTRA_AGENT_TURN_ANSWER_COMMAND) &&
          hasMastraAgentTurnForbiddenKey(rendererSafeArgs);
        const callerIdentity = profileEgress?.issueCallerIdentity(
          event.sender.id,
        );
        // Keep the main-issued identity available to the profile gate and the
        // generic DB adapter without changing the enumerable wire shape of
        // typed commands. A number of existing Native requests deliberately
        // reject unknown fields, so an enumerable authority sidecar would
        // make otherwise valid UI calls fail their exact-key validation.
        let dispatchArgs = callerIdentity
          ? Object.defineProperty({ ...rendererSafeArgs }, "callerIdentity", {
              value: callerIdentity,
              enumerable: false,
              configurable: true,
            })
          : rendererSafeArgs;
        // DA-2 (DR-DA2-9, DR-DA2-16): Main answers these two itself, before
        // the invoke check, with closed codes only; they never reach Native.
        // The state also answers while unavailable or after a failed caller
        // registration.
        if (cmd === PROFILE_EGRESS_STATUS_COMMAND) {
          return {
            ok: true,
            value: profileEgress?.statusView?.() ?? {
              state: "unavailable",
              reason: "backend-unavailable",
            },
          };
        }
        if (cmd === PROFILE_ACTIVATION_REQUEST_COMMAND) {
          return {
            ok: true,
            value: profileActivation
              ? await profileActivation.request({
                  sender: event.sender,
                  win,
                  callerIdentity,
                })
              : { status: "unavailable" },
          };
        }
        try {
          profileEgress?.assertInvoke(cmd, dispatchArgs);
        } catch (error) {
          return { ok: false, error: toErrorString(error) };
        }
        // `own-data-read` (K3/2): Main's own classification of a generic DB
        // statement travels to Native as a non-enumerable, symbol-keyed
        // sidecar so Native can require a read-only statement. Any value of
        // that key a caller supplied is discarded first; it is never used.
        if (cmd === "db_execute" || cmd === "db_execute_batch") {
          Reflect.deleteProperty(dispatchArgs, D2A_DB_OWN_DATA_READ);
          const ownDataRead = profileEgress?.classifyOwnDataRead?.(
            cmd,
            dispatchArgs,
          );
          if (ownDataRead !== undefined) {
            Object.defineProperty(dispatchArgs, D2A_DB_OWN_DATA_READ, {
              value: ownDataRead,
              enumerable: false,
              configurable: true,
            });
          }
        }
        const nir1LocalContext = isNir1LocalGenerationCommand(cmd)
          ? { sender: event.sender, win, callerIdentity }
          : null;
        if (isNir1LocalGenerationCommand(cmd) && nir1LocalContext) {
          const refusal = await nir1LocalGeneration.admit(
            cmd,
            nir1LocalContext,
            dispatchArgs,
          );
          if (refusal) return refusal;
        }
        if (isMastraAgentTurnCommand(cmd)) {
          const refusal = mastraAgentTurn.admit(cmd, {
            sender: event.sender,
            win,
            callerIdentity,
          });
          if (refusal) return refusal;
          if (mastraForgedKey) {
            return {
              ok: true,
              value: mastraAgentTurnRefusalValue(cmd, "invalid"),
            };
          }
        }
        if (cmd === MASTRA_AGENT_TURN_ANSWER_COMMAND && mastraForgedKey) {
          return { ok: true, value: { status: "refused", reason: "invalid" } };
        }
        const dispatch = async (args = dispatchArgs): Promise<Envelope> => {
          // D-10 (DR-DA2-18): an admitted stream is recorded until its invoke
          // settles, so stage 2 can send it a typed terminal.
          const releaseStream =
            aiStreamTerminals?.track(event.sender.id, cmd, args) ?? null;
          try {
            return await dispatchInvoke(cmd, args, {
              backend,
              shell: {
                ...buildShellCommandHandlers(win),
                ...injectedHandlers,
                ...(isMastraAgentTurnCommand(cmd) ||
                cmd === MASTRA_AGENT_TURN_ANSWER_COMMAND
                  ? mastraAgentTurn.handlersFor({
                      sender: event.sender,
                      win,
                      callerIdentity,
                    })
                  : {}),
              },
              secrets,
              broadcast,
              issueAgentAuthorityCapabilities: (agentArgs, response) =>
                issueAgentAuthorityCapabilitiesForSender(
                  event.sender.id,
                  agentArgs,
                  response,
                  backend,
                  callerIdentity,
                ),
            });
          } finally {
            releaseStream?.();
          }
        };
        let envelope: Envelope;
        let manualMaintenanceAttemptId: string | null = null;
        try {
          if (WORKSPACE_SWITCH_COMMANDS.has(cmd)) {
            const requestedWorkspacePath =
              cmd === "open_workspace" && "path" in dispatchArgs
                ? dispatchArgs.path
                : undefined;
            if (
              cmd === "open_workspace" &&
              (typeof requestedWorkspacePath !== "string" ||
                requestedWorkspacePath.trim().length === 0 ||
                requestedWorkspacePath.includes("\0"))
            ) {
              throw new Error(
                "invalid args `path` for command `open_workspace`: expected a non-empty path",
              );
            }
            const acquired: Array<
              | NarrativeMaintenanceQuiesceLease
              | NarrativeFreshnessQuiesceLease
              | MastraTurnSwitchLease
            > = [];
            try {
              // Mastra agent turns first (DR-MP3-12): admission closes and every
              // turn is aborted synchronously, and each one's ambiguous terminal
              // is written to the OLD workspace (bounded) before Native's open,
              // which could not write to it afterwards. Native's send is not
              // stopped; the open still waits for it as it does today.
              const mastraLease =
                await mastraTurnOwner?.quiesceForWorkspaceSwitch?.();
              if (mastraLease) acquired.push(mastraLease);
              const maintenanceLease =
                await narrativeMaintenance?.quiesceForWorkspaceSwitch?.();
              if (
                maintenanceLease &&
                typeof maintenanceLease === "object" &&
                typeof maintenanceLease.resume === "function"
              ) {
                acquired.push(maintenanceLease);
              }
              const freshnessLease =
                await narrativeFreshness?.quiesceForWorkspaceSwitch?.();
              if (
                freshnessLease &&
                typeof freshnessLease === "object" &&
                typeof freshnessLease.resume === "function"
              ) {
                acquired.push(freshnessLease);
              }
              if (typeof requestedWorkspacePath === "string") {
                // Freshness can publish a recovery descriptor while joining.
                // Keep both producers stopped until Native has reconciled
                // only this Open target and main has ACKed its exact proof.
                await narrativeMaintenance?.reconcileRecoveryBeforeWorkspaceOpen?.(
                  requestedWorkspacePath,
                );
              }
              workspaceSwitchLeases = acquired;
            } catch (error) {
              await Promise.all(
                acquired.map((lease) =>
                  Promise.resolve(lease.resume(false)).catch(() => undefined),
                ),
              );
              throw error;
            }
          }
          if (
            MANUAL_NARRATIVE_MAINTENANCE_COMMANDS.has(cmd) &&
            typeof narrativeMaintenance?.beginNarrativeMaintenanceAttempt ===
              "function" &&
            typeof narrativeMaintenance?.cancelNarrativeMaintenanceAttempt ===
              "function"
          ) {
            const binding = normalizeWorkspaceBinding(
              backend?.getNarrativeMaintenanceWorkspaceBinding?.(),
            );
            if (binding !== null) {
              const attemptId = `manual-ipc-${randomUUID()}`;
              await narrativeMaintenance.beginNarrativeMaintenanceAttempt(
                attemptId,
                binding,
              );
              manualMaintenanceAttemptId = attemptId;
              if (isRecord(dispatchArgs) && isRecord(dispatchArgs.payload)) {
                // The attempt identity is issued by main after the renderer
                // request has passed its authority gate. Native binds the
                // manual operation to this exact process-local attempt.
                dispatchArgs = {
                  ...dispatchArgs,
                  payload: {
                    ...dispatchArgs.payload,
                    attemptId,
                  },
                };
              } else {
                throw new Error(
                  "NEX_MAINTENANCE_ATTEMPT_PAYLOAD_MISSING: manual maintenance payload is unavailable",
                );
              }
            }
          }
          if (isGrantRequiredCommand(cmd)) {
            // Never dispatched on the renderer's word: Main's confirmation
            // (preview, dialog, issue) comes first, or the command is refused.
            envelope = mainGrant
              ? await mainGrant.run({
                  command: cmd,
                  sender: event.sender,
                  win,
                  args: dispatchArgs,
                  dispatch,
                })
              : { ok: false, error: MAIN_GRANT_REQUIRED };
          } else {
            envelope =
              licenseValidation && MANUAL_LICENSE_COMMANDS.has(cmd)
                ? await licenseValidation.runManualOperation(dispatch)
                : await dispatch();
          }
        } catch (error) {
          envelope = { ok: false, error: toErrorString(error) };
        }
        if (cmd === "capture_current_chat_input") {
          const legacyOnly =
            envelope.ok &&
            isRecord(envelope.value) &&
            envelope.value.status === "legacy-only";
          const cancelCommittedCapture = async (): Promise<void> => {
            const rawSubmission = (dispatchArgs as Record<string, unknown>)
              .submission;
            const submission =
              isRecord(rawSubmission) &&
              [
                rawSubmission.submissionId,
                rawSubmission.messageId,
                rawSubmission.chatSessionId,
                rawSubmission.sceneId,
              ].every((value) => typeof value === "string")
                ? {
                    submissionId: rawSubmission.submissionId as string,
                    messageId: rawSubmission.messageId as string,
                    chatSessionId: rawSubmission.chatSessionId as string,
                    sceneId: rawSubmission.sceneId as string,
                  }
                : null;
            if (
              !submission ||
              !callerIdentity ||
              !backend?.cancelCurrentChatInput
            ) {
              return;
            }
            const raw = await backend.cancelCurrentChatInput(
              submission,
              JSON.stringify(callerIdentity),
            );
            const receipt: unknown = JSON.parse(raw);
            if (
              !isRecord(receipt) ||
              !["cancelled", "not-current", "not-found"].includes(
                String(receipt.status),
              ) ||
              receipt.submissionId !== submission.submissionId ||
              receipt.messageId !== submission.messageId
            ) {
              throw new Error("IPC_CAPTURE_CANCEL_TERMINAL_RECEIPT_INVALID");
            }
          };
          if (envelope.ok && !legacyOnly && event.sender.isDestroyed()) {
            try {
              await cancelCommittedCapture();
            } catch (error) {
              console.warn(
                "[ipc] sender-lost chat capture cancellation failed",
                toErrorString(error),
              );
            }
            envelope = {
              ok: false,
              error:
                "IPC_CAPTURE_OUTCOME_UNKNOWN: sender was destroyed after local Native admission",
            };
          } else if (envelope.ok && !legacyOnly) {
            try {
              // The Native transaction may have committed before a workspace
              // or caller transition. Never acknowledge that stale result as
              // accepted; terminalize that exact insert when the old Native
              // owner is still live, otherwise the incarnation check rejects reuse.
              profileEgress?.assertInvoke(cmd, dispatchArgs);
            } catch (error) {
              try {
                await cancelCommittedCapture();
              } catch (cleanupError) {
                console.warn(
                  "[ipc] stale chat capture cancellation failed",
                  toErrorString(cleanupError),
                );
              }
              envelope = {
                ok: false,
                error: `IPC_CAPTURE_OUTCOME_UNKNOWN: ${toErrorString(error)}`,
              };
            }
          } else if (!envelope.ok) {
            try {
              // Native may commit and then fail its post-commit workspace check.
              await cancelCommittedCapture();
            } catch (error) {
              console.warn(
                "[ipc] failed chat capture cleanup failed",
                toErrorString(error),
              );
            }
          }
        }
        if (cmd === "open_workspace" && envelope.ok && "path" in dispatchArgs) {
          // Consume Native's exact terminal proof before renderer hydration;
          // the nonblocking Opened/Ready callbacks may still be queued.
          profileEgress?.observeWorkspaceOpenResult?.(
            envelope.value,
            dispatchArgs.path as string,
          );
        }
        if (cmd === "restore_backup" && envelope.ok) {
          // The renderer also consumes this operation-scoped result, but the
          // main profile gate must see the trusted Native proof first.  A
          // failed Restore may return `unchanged` without another
          // `workspace:opened`; feed that proof into the same authorization
          // owner before the next renderer invoke can mint a caller.
          profileEgress?.observeWorkspaceLifecycleResult?.(envelope.value);
        }
        if (
          manualMaintenanceAttemptId !== null &&
          typeof narrativeMaintenance?.cancelNarrativeMaintenanceAttempt ===
            "function"
        ) {
          try {
            const receipt =
              await narrativeMaintenance.cancelNarrativeMaintenanceAttempt(
                manualMaintenanceAttemptId,
                "closed",
              );
            const receiptRecord = isRecord(receipt) ? receipt : null;
            const cleanup =
              receiptRecord && isRecord(receiptRecord.cleanup)
                ? receiptRecord.cleanup
                : null;
            const reusable =
              receiptRecord?.connectionReusable === true &&
              cleanup?.status === "clean";
            if (!reusable && envelope.ok) {
              envelope = {
                ok: false,
                error:
                  "NEX_MAINTENANCE_CONNECTION_UNUSABLE: manual maintenance terminal receipt did not prove Native connection reuse",
              };
            }
          } catch (error) {
            const cleanupError = toErrorString(error);
            envelope = envelope.ok
              ? { ok: false, error: cleanupError }
              : {
                  ok: false,
                  error: `${envelope.error}; ${cleanupError}`,
                };
          }
        }
        if (envelope.ok) {
          const resultKind = nativeDbResultKind(cmd, envelope.value);
          if (resultKind === "invalid") {
            envelope = {
              ok: false,
              error: "D2A_EGRESS_DENIED: invalid native database result kind",
            };
          } else if (!isOpaqueCommittedDbMutationReceipt(cmd, envelope.value)) {
            const admittedValue = envelope.value;
            try {
              // A result admitted before activation may finish after the
              // profile gate closes. Re-check only plaintext publication
              // routes here. Native's result kind is authoritative for the
              // distinction between a read and a mutation; never re-infer it
              // from the SQL text in main.
              profileEgress?.assertPlaintextPublication(cmd, dispatchArgs);
              if (resultKind !== null) {
                envelope = {
                  ok: true,
                  value: stripNativeDbResultKind(envelope.value),
                };
              }
            } catch (error) {
              if (resultKind === "committed-mutation") {
                // The mutation is already durable. Do not report it as a
                // rejected operation, and do not expose rows that may contain
                // protected RETURNING/plaintext data.
                envelope = { ok: true, value: { rows: [], committed: true } };
              } else {
                if (
                  cmd === "related_scenes_begin" &&
                  typeof boundArgs.ownerKey === "string"
                ) {
                  // Native created the pending operation before this check
                  // refused its result. Nothing was tracked or returned, so
                  // release it here instead of leaving an owner/ticket that
                  // only the lease TTL would reclaim.
                  releaseUnpublishedRelatedScenesOperation(
                    backend,
                    boundArgs.ownerKey,
                    admittedValue,
                  );
                }
                if (isNir1LocalGenerationCommand(cmd)) {
                  // A start whose handle is not returned leaves no running
                  // generation behind (DR-DD1B-7).
                  nir1LocalGeneration.onUnpublished(cmd, event.sender.id);
                }
                envelope = { ok: false, error: toErrorString(error) };
              }
            }
          }
        }
        if (isNir1LocalGenerationCommand(cmd) && nir1LocalContext) {
          envelope = nir1LocalGeneration.settle(
            cmd,
            nir1LocalContext,
            dispatchArgs,
            envelope,
          );
        }
        if (envelope.ok && typeof boundArgs.ownerKey === "string") {
          if (cmd === "related_scenes_begin" && isRecord(envelope.value)) {
            const ir = envelope.value.ir;
            if (
              isRecord(ir) &&
              ir.status === "pending" &&
              typeof ir.operationTicket === "string"
            ) {
              relatedScenesReconciler.track(
                boundArgs.ownerKey,
                ir.operationTicket,
              );
            }
          } else if (
            cmd === "related_scenes_release" &&
            typeof boundArgs.operationTicket === "string"
          ) {
            relatedScenesReconciler.release(
              boundArgs.ownerKey,
              boundArgs.operationTicket,
            );
          }
        }
        if (envelope.ok) {
          postprocessSuccessfulWriter(
            cmd,
            boundArgs,
            envelope.value,
            event.sender.id,
            () => relatedScenesReconciler.wake(),
          );
        }
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
            const claimedRunId =
              await claimNarrativeMaintenanceForegroundRelease(
                backend,
                payload.projectId,
              );
            if (claimedRunId !== null) {
              scheduleNarrativeMaintenanceForegroundRelease(
                backend,
                payload.projectId,
                claimedRunId,
              );
            }
          }
        }
        if (workspaceSwitchLeases.length > 0) {
          const leases = workspaceSwitchLeases;
          workspaceSwitchLeases = [];
          await Promise.all(
            leases.map(async (lease) => {
              try {
                // Restore retained maintenance/Freshness work after the
                // workspace switch attempt. Each lease remains closed after
                // cleanup failure and rejects stale/overlapping resumes.
                await lease.resume(envelope.ok);
              } catch (resumeError) {
                console.warn(
                  "[narrative-maintenance] failed to resume retained workspace participants:",
                  resumeError,
                );
              }
            }),
          );
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
  const panelWindowDelegate = {
    open: openPanelWindow,
    focusByLabel: focusPanelWindow,
    existsByLabel: hasPanelWindow,
  };
  if (profileEgress) {
    registerShellBridgeHandlers(panelWindowDelegate, undefined, () =>
      profileEgress.assertExternalUrl(),
    );
  } else {
    registerShellBridgeHandlers(panelWindowDelegate);
  }
}
