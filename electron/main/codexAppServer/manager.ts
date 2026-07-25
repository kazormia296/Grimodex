import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../../shared/ipcContract.js";
import {
  type ArchiveCodexSessionThreadPayload,
  type AdvanceCodexHistoryRevisionPayload,
  type AdvanceCodexHistoryRevisionResult,
  buildCodexTurnInput,
  CODEX_APP_SERVER_WORKSPACE_STALE_CODE,
  type CodexAppEventEnvelope,
  type CodexAppServerStatus,
  type CodexModel,
  type CodexRuntimeThreadBinding,
  type InterruptCodexAppTurnPayload,
  type JsonRpcId,
  type RespondCodexServerRequestPayload,
  type SetCodexThreadNamePayload,
  type StartCodexAppTurnPayload,
  type StartCodexAppTurnResult,
} from "../../shared/codexAppProtocol.js";
import { mapCodexNotification } from "./eventMapper.js";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { JsonRpcConnection, JsonRpcRemoteError } from "./jsonRpcConnection.js";
import {
  CodexAppServerProcess,
  type CodexAppServerProcessOptions,
} from "./process.js";
import {
  parseServerRequestId,
  type RuntimeThreadBindingStore,
} from "./threadBindingStore.js";

export const CODEX_APP_RUNTIME = "codex-app-server";
export const CODEX_APP_SERVER_EVENT_CHANNEL = "codex-app:event";
export const CODEX_APP_SERVER_PRE_TURN_CODE = "CODEX_APP_SERVER_PRE_TURN";
export const CODEX_APP_SERVER_REQUEST_DENIED_CODE =
  "CODEX_APP_SERVER_REQUEST_DENIED";

const MAX_ID_LENGTH = 256;
const MAX_WORKSPACE_PATH_BYTES = 32 * 1024;
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_RPC_LINE_BYTES = MAX_PACKET_BYTES + 512 * 1024;
const MAX_MODEL_LIST_PAGES = 100;
const MAX_MODEL_CURSOR_LENGTH = 8 * 1024;
const MAX_COMPLETED_TURN_RECEIPTS = 256;
const COMPLETED_TURN_RECEIPT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60 * 1000;
// Renderer history revisions are `empty` or content hashes. This reserved
// prefix marks a binding whose remote turn has not yet been committed to the
// local chat history and therefore must never be resumed after a restart.
const PENDING_HISTORY_REVISION_PREFIX = "__grimodex_pending_v1__:";
const GRIMODEX_READ_ONLY_INSTRUCTIONS = [
  "You are operating inside Grimodex.",
  "The newest <grimodex-context> block is authoritative.",
  "The initial release is read-only: do not modify files, execute commands, or call write tools.",
  "Answer only the newest <user-request>.",
].join("\n");

const GRIMODEX_APPROVAL_INSTRUCTIONS = [
  "You are operating inside Grimodex.",
  "The newest <grimodex-context> block is authoritative.",
  "Workspace file changes are allowed only after the user approves the exact request in Grimodex.",
  "Never execute commands; command-execution approvals are not supported by Grimodex.",
  "Never access paths outside the active workspace or bypass the approval flow.",
  "Structured Grimodex data writes must remain proposals and use the existing tracked write path.",
  "Answer only the newest <user-request>.",
].join("\n");

function instructionsForTurn(allowApprovals: boolean): string {
  return allowApprovals
    ? GRIMODEX_APPROVAL_INSTRUCTIONS
    : GRIMODEX_READ_ONLY_INSTRUCTIONS;
}

interface CodexAppServerProcessLike {
  start(): Promise<void>;
  dispose(): Promise<void>;
  write(line: string): void;
  onData(listener: (chunk: Buffer | string) => void): () => void;
  onClose(listener: (cause?: Error) => void): () => void;
  onError(listener: (cause: Error) => void): () => void;
  close(): void;
  getStderrTail?(): string;
}

interface ActiveTurn {
  ownerId: number | null;
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  workspacePath: string;
  workspaceAliasPath: string;
  allowApprovals: boolean;
  turnStarted: boolean;
  outputStarted: boolean;
  interruptRequested: boolean;
  interruptSent: boolean;
  binding: CodexRuntimeThreadBinding;
  bindingPersisted: boolean;
  bindingPersistFlight: Promise<void> | null;
  historyRevision: string;
  fileChangeDetails: Map<string, FileChangeApprovalDetails>;
}

interface CompletedTurnReceipt {
  ownerId: number | null;
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  codexThreadId: string;
  codexTurnId: string;
  workspacePath: string;
  historyRevision: string;
  advancedHistoryRevision: string | null;
  bindingPersistFlight: Promise<void>;
  completedAtMs: number;
}

type FileChangeApprovalDetails =
  | { ok: true; affectedPaths: string[]; diff: string }
  | { ok: false; message: string };

interface StartingTurn {
  ownerId: number | null;
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  interruptRequested: boolean;
  interruptSent: boolean;
  /** True immediately before the first `turn/start` request is dispatched. */
  turnStartDispatched: boolean;
}

interface PendingServerRequest {
  ownerId: number | null;
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  requestId: JsonRpcId;
  timeout: ReturnType<typeof setTimeout>;
  validateAccept?: () => void | Promise<void>;
  resolve: (value: unknown) => void;
  reject: (cause: Error) => void;
}

export interface CodexMcpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CodexAppServerManagerOptions {
  broadcast?: (channel: string, payload: unknown) => void;
  sendToOwner?: (ownerId: number, channel: string, payload: unknown) => void;
  createProcess?: () =>
    | CodexAppServerProcessLike
    | Promise<CodexAppServerProcessLike>;
  authorizeExecutable?: CodexAppServerProcessOptions["authorizeExecutable"];
  /** Main-owned persisted setting. Renderer payloads never control this. */
  getConfiguredExecutable?: CodexAppServerProcessOptions["getConfiguredExecutable"];
  /** Main-owned isolated CODEX_HOME. Renderer payloads never control this. */
  codexHomeDir?: CodexAppServerProcessOptions["codexHomeDir"];
  getWorkspacePath?: () => Promise<string>;
  threadBindings: RuntimeThreadBindingStore;
  appVersion?: string;
  now?: () => Date;
  allowApprovals?: boolean;
  /** Main-owned persisted opt-in. Renderer payloads never control this. */
  getAllowApprovals?: () => Promise<boolean>;
  /** Main-owned, read-only Grimodex MCP config. Never accepts renderer paths. */
  getReadOnlyMcpServer?: (
    projectId: string,
    workspacePath: string,
  ) => Promise<CodexMcpServerConfig | null>;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

export interface CodexAppServerManager {
  readonly handlers: ShellCommandHandlers;
  handlersForOwner(ownerId: number): ShellCommandHandlers;
  getStatus(): CodexAppServerStatus;
  listModels(): Promise<CodexModel[]>;
  startTurn(
    input: StartCodexAppTurnPayload,
    ownerId?: number | null,
  ): Promise<{
    codexThreadId: string;
    codexTurnId: string;
    reusedThread: boolean;
  }>;
  interruptTurn(
    input: InterruptCodexAppTurnPayload,
    ownerId?: number | null,
  ): Promise<void>;
  advanceHistoryRevision(
    input: AdvanceCodexHistoryRevisionPayload,
    ownerId?: number | null,
  ): Promise<AdvanceCodexHistoryRevisionResult>;
  respondToServerRequest(
    input: RespondCodexServerRequestPayload,
    ownerId?: number | null,
  ): Promise<void>;
  archiveSessionThread(input: ArchiveCodexSessionThreadPayload): Promise<void>;
  setThreadName(input: SetCodexThreadNamePayload): Promise<void>;
  handleWorkspaceChanged(): Promise<void>;
  handleOwnerDestroyed(ownerId: number): Promise<void>;
  dispose(): Promise<void>;
}

export class CodexAppServerError extends Error {
  readonly code: string;
  readonly preTurn: boolean;

  constructor(message: string, code: string, preTurn = false) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.preTurn = preTurn;
  }
}

export function isCodexAppServerPreTurnError(
  value: unknown,
): value is CodexAppServerError {
  return value instanceof CodexAppServerError && value.preTurn;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(args: CommandArgs, key: string): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new Error(`invalid args \`${key}\`: expected a non-empty string`);
  }
  return value;
}

function optionalString(args: CommandArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH) {
    throw new Error(`invalid args \`${key}\`: expected a string`);
  }
  return value;
}

function packetString(args: CommandArgs, key: string): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PACKET_BYTES
  ) {
    throw new Error(`invalid args \`${key}\`: packet is empty or too large`);
  }
  return value;
}

function workspacePathString(args: CommandArgs, key: string): string {
  const value = args[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > MAX_WORKSPACE_PATH_BYTES ||
    !path.isAbsolute(value)
  ) {
    throw new Error(
      `invalid args \`${key}\`: expected a bounded absolute workspace path`,
    );
  }
  return value;
}

function optionalPacketString(
  args: CommandArgs,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PACKET_BYTES
  ) {
    throw new Error(`invalid args \`${key}\`: packet is too large`);
  }
  return value;
}

function extractThreadId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const thread = isRecord(value.thread) ? value.thread : undefined;
  const id = value.threadId ?? value.id ?? thread?.id ?? thread?.threadId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function extractTurnId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const turn = isRecord(value.turn) ? value.turn : undefined;
  const id = value.turnId ?? value.id ?? turn?.id ?? turn?.turnId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function findTurnIdInParams(value: unknown): string | undefined {
  const id = extractTurnId(value);
  return id ?? undefined;
}

function findThreadIdInParams(value: unknown): string | undefined {
  const id = extractThreadId(value);
  return id ?? undefined;
}

function normalizeModels(value: unknown): CodexModel[] {
  const record = isRecord(value) ? value : undefined;
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(record?.models)
      ? record.models
      : Array.isArray(record?.data)
        ? record.data
        : [];
  return raw.flatMap((entry): CodexModel[] => {
    if (!isRecord(entry)) return [];
    const id =
      typeof entry.id === "string"
        ? entry.id
        : typeof entry.slug === "string"
          ? entry.slug
          : null;
    if (!id) return [];
    const name =
      typeof entry.name === "string"
        ? entry.name
        : typeof entry.displayName === "string"
          ? entry.displayName
          : typeof entry.display_name === "string"
            ? entry.display_name
            : id;
    return [
      {
        id,
        name,
        ...(typeof entry.description === "string"
          ? { description: entry.description }
          : {}),
      },
    ];
  });
}

function nextModelCursor(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const cursor = value.nextCursor;
  if (cursor === undefined || cursor === null) return null;
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    cursor.length > MAX_MODEL_CURSOR_LENGTH
  ) {
    throw new CodexAppServerError(
      "Codex App Server returned an invalid model cursor",
      "CODEX_APP_SERVER_PROTOCOL",
    );
  }
  return cursor;
}

function keyFor(
  projectId: string,
  sessionId: string,
  grimodexTurnId: string,
): string {
  return `${projectId}\u0000${sessionId}\u0000${grimodexTurnId}`;
}

function sessionKeyFor(projectId: string, sessionId: string): string {
  return `${projectId}\u0000${sessionId}`;
}

function requestKey(requestId: JsonRpcId): string {
  return typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function pendingHistoryRevisionFor(grimodexTurnId: string): string {
  return `${PENDING_HISTORY_REVISION_PREFIX}${grimodexTurnId}`;
}

function isPendingHistoryRevision(value: string | null): boolean {
  return value?.startsWith(PENDING_HISTORY_REVISION_PREFIX) === true;
}

function canonicalWorkspacePath(workspacePath: string): string {
  return realpathSync.native(path.resolve(workspacePath));
}

function assertExpectedWorkspacePath(
  rendererWorkspacePath: string,
  authoritativeWorkspacePath: string,
  preTurn: boolean,
): void {
  let expected: string;
  try {
    expected = canonicalWorkspacePath(rendererWorkspacePath);
  } catch {
    throw new CodexAppServerError(
      "The renderer workspace is unavailable or stale",
      CODEX_APP_SERVER_WORKSPACE_STALE_CODE,
      preTurn,
    );
  }
  if (expected !== authoritativeWorkspacePath) {
    throw new CodexAppServerError(
      "The active workspace no longer matches the renderer request",
      CODEX_APP_SERVER_WORKSPACE_STALE_CODE,
      preTurn,
    );
  }
}

const MAX_APPROVAL_COMMAND_CHARS = 128 * 1024;
const MAX_APPROVAL_PATHS = 256;
const MAX_APPROVAL_DIFF_CHARS = 512 * 1024;
const MAX_APPROVAL_SUMMARY_CHARS = 8 * 1024;

function optionalApprovalString(
  value: unknown,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new CodexAppServerError(
      `Codex approval field is invalid or too large: ${field}`,
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  return value;
}

function pathWithinWorkspace(
  rawPath: string,
  workspacePath: string,
  workspaceAliasPath: string = workspacePath,
): string {
  const workspace = path.resolve(workspacePath);
  const workspaceAlias = path.resolve(workspaceAliasPath);
  const candidate = path.resolve(workspaceAlias, rawPath);
  const roots =
    workspaceAlias === workspace ? [workspace] : [workspaceAlias, workspace];
  let relative: string | null = null;
  for (const root of roots) {
    const candidateRelative = path.relative(root, candidate);
    if (
      candidateRelative !== ".." &&
      !candidateRelative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(candidateRelative)
    ) {
      relative = candidateRelative;
      break;
    }
  }
  if (relative === null) {
    throw new CodexAppServerError(
      "Codex approval references a path outside the active workspace",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  const realWorkspace = realpathSync.native(workspace);
  if (realWorkspace !== workspace) {
    throw new CodexAppServerError(
      "The active workspace root changed before approval",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  let existingAncestor = candidate;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new CodexAppServerError(
        "Codex approval path has no existing workspace ancestor",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    existingAncestor = parent;
  }
  const realAncestor = realpathSync.native(existingAncestor);
  const realRelative = path.relative(realWorkspace, realAncestor);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new CodexAppServerError(
      "Codex approval path resolves outside the active workspace",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  return relative ? relative.split(path.sep).join("/") : ".";
}

function validateAvailableDecisions(params: Record<string, unknown>): void {
  const available = params.availableDecisions;
  if (available === undefined || available === null) return;
  if (!Array.isArray(available)) {
    throw new CodexAppServerError(
      "Codex approval availableDecisions is invalid",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  const decisions = new Set(
    available.filter((value): value is string => typeof value === "string"),
  );
  if (!decisions.has("accept") || !decisions.has("decline")) {
    throw new CodexAppServerError(
      "Codex approval cannot be represented by the Grimodex decision UI",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
}

function fileChangeUpdate(
  params: unknown,
  workspacePath: string,
  workspaceAliasPath: string,
): { itemId: string; details: FileChangeApprovalDetails } | null {
  if (!isRecord(params)) return null;
  const item = isRecord(params.item) ? params.item : params;
  if (isRecord(params.item) && item.type !== "fileChange") return null;
  const itemId =
    typeof item.id === "string"
      ? item.id
      : typeof params.itemId === "string"
        ? params.itemId
        : null;
  const changes = Array.isArray(item.changes)
    ? item.changes
    : Array.isArray(params.changes)
      ? params.changes
      : null;
  if (!itemId || !changes) return null;
  try {
    if (changes.length === 0 || changes.length > MAX_APPROVAL_PATHS) {
      throw new Error("Codex file-change contains too many changes");
    }
    const affectedPaths: string[] = [];
    const diffs: string[] = [];
    for (const change of changes) {
      if (
        !isRecord(change) ||
        typeof change.path !== "string" ||
        change.path.length === 0 ||
        typeof change.diff !== "string"
      ) {
        throw new Error("Codex file-change details are invalid");
      }
      const kind = change.kind;
      if (
        !isRecord(kind) ||
        (kind.type !== "add" &&
          kind.type !== "delete" &&
          kind.type !== "update")
      ) {
        throw new Error("Codex file-change kind is invalid");
      }
      affectedPaths.push(
        pathWithinWorkspace(change.path, workspacePath, workspaceAliasPath),
      );
      if ("move_path" in kind) {
        if (
          kind.type !== "update" ||
          (kind.move_path !== null &&
            (typeof kind.move_path !== "string" || kind.move_path.length === 0))
        ) {
          throw new Error("Codex file-change move path is invalid");
        }
        if (typeof kind.move_path === "string") {
          affectedPaths.push(
            pathWithinWorkspace(
              kind.move_path,
              workspacePath,
              workspaceAliasPath,
            ),
          );
        }
      }
      diffs.push(change.diff);
    }
    const uniquePaths = [...new Set(affectedPaths)];
    if (uniquePaths.length > MAX_APPROVAL_PATHS) {
      throw new Error("Codex file-change contains too many paths");
    }
    const diff = diffs.join("\n");
    if (diff.length > MAX_APPROVAL_DIFF_CHARS) {
      throw new Error("Codex file-change diff is too large");
    }
    return { itemId, details: { ok: true, affectedPaths: uniquePaths, diff } };
  } catch (cause) {
    return {
      itemId,
      details: {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      },
    };
  }
}

function canRetryThreadStartWithoutMcp(cause: unknown): boolean {
  if (!(cause instanceof JsonRpcRemoteError)) return false;
  const details = `${cause.message} ${
    cause.data === undefined ? "" : JSON.stringify(cause.data)
  }`;
  return (
    /\bmcp(?:_servers)?\b/i.test(details) &&
    /unknown|invalid|unsupported|additional propert|unrecognized|not found/i.test(
      details,
    )
  );
}

export function createCodexAppServerManager(
  options: CodexAppServerManagerOptions,
): CodexAppServerManager {
  const now = options.now ?? (() => new Date());
  const approvalTimeoutMs =
    typeof options.approvalTimeoutMs === "number" &&
    Number.isFinite(options.approvalTimeoutMs) &&
    options.approvalTimeoutMs > 0
      ? options.approvalTimeoutMs
      : DEFAULT_APPROVAL_TIMEOUT_MS;
  const broadcast = options.broadcast ?? (() => {});
  const publish = (
    ownerId: number | null,
    channel: string,
    payload: unknown,
  ): void => {
    if (ownerId !== null && options.sendToOwner) {
      options.sendToOwner(ownerId, channel, payload);
      return;
    }
    broadcast(channel, payload);
  };
  const createProcess =
    options.createProcess ??
    (() =>
      new CodexAppServerProcess({
        authorizeExecutable: options.authorizeExecutable,
        getConfiguredExecutable: options.getConfiguredExecutable,
        codexHomeDir: options.codexHomeDir,
      }));
  let status: CodexAppServerStatus = {
    state: "stopped",
    version: null,
    lastError: null,
    startedAt: null,
  };
  let process: CodexAppServerProcessLike | null = null;
  let connection: JsonRpcConnection | null = null;
  let startFlight: Promise<void> | null = null;
  let disposed = false;
  const activeTurns = new Map<string, ActiveTurn>();
  const startingTurns = new Map<string, StartingTurn>();
  const completedTurns = new Map<string, CompletedTurnReceipt>();
  const pendingRequests = new Map<string, PendingServerRequest>();
  const sessionOperationTails = new Map<string, Promise<void>>();

  const withSessionOperation = async <T>(
    projectId: string,
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = sessionKeyFor(projectId, sessionId);
    const previous = sessionOperationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    sessionOperationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (sessionOperationTails.get(key) === tail) {
        sessionOperationTails.delete(key);
      }
    }
  };

  const pruneCompletedTurns = (): void => {
    const cutoff = now().getTime() - COMPLETED_TURN_RECEIPT_TTL_MS;
    for (const [key, receipt] of completedTurns) {
      if (receipt.completedAtMs < cutoff) completedTurns.delete(key);
    }
    while (completedTurns.size > MAX_COMPLETED_TURN_RECEIPTS) {
      const oldest = completedTurns.keys().next().value as string | undefined;
      if (!oldest) break;
      completedTurns.delete(oldest);
    }
  };

  const rememberCompletedTurn = (
    active: ActiveTurn,
    bindingPersistFlight: Promise<void>,
  ): void => {
    if (!active.codexTurnId) return;
    const key = keyFor(
      active.projectId,
      active.sessionId,
      active.grimodexTurnId,
    );
    // Reinsert so Map order reflects completion time for bounded eviction.
    completedTurns.delete(key);
    completedTurns.set(key, {
      ownerId: active.ownerId,
      projectId: active.projectId,
      sessionId: active.sessionId,
      grimodexTurnId: active.grimodexTurnId,
      codexThreadId: active.codexThreadId,
      codexTurnId: active.codexTurnId,
      workspacePath: active.workspacePath,
      historyRevision: active.historyRevision,
      advancedHistoryRevision: null,
      bindingPersistFlight,
      completedAtMs: now().getTime(),
    });
    pruneCompletedTurns();
  };

  const assertOwner = (
    expectedOwnerId: number | null,
    ownerId: number | null,
  ): void => {
    if (expectedOwnerId !== null && expectedOwnerId !== ownerId) {
      throw new Error("Codex turn authority mismatch");
    }
  };

  const assertWorkspaceStillActive = async (
    expectedWorkspacePath: string,
  ): Promise<void> => {
    const current = await options.getWorkspacePath?.();
    let canonicalCurrent: string | null = null;
    try {
      canonicalCurrent = current ? canonicalWorkspacePath(current) : null;
    } catch {
      canonicalCurrent = null;
    }
    if (canonicalCurrent !== expectedWorkspacePath) {
      throw new CodexAppServerError(
        "Active workspace changed while the Codex turn was starting",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
  };

  const persistActiveBinding = async (active: ActiveTurn): Promise<void> => {
    if (!active.codexTurnId || active.bindingPersisted) return;
    if (!active.bindingPersistFlight) {
      // Install the shared flight before the first await. A terminal
      // notification can otherwise publish a completion receipt while the
      // workspace check is still pending, allowing the revision CAS to race
      // ahead of the authoritative turn-id update.
      active.bindingPersistFlight = (async () => {
        await assertWorkspaceStillActive(active.workspacePath);
        await options.threadBindings.upsert(
          {
            ...active.binding,
            lastTurnId: active.codexTurnId,
            updatedAt: nowIso(now),
          },
          active.workspacePath,
        );
        active.bindingPersisted = true;
      })().finally(() => {
        active.bindingPersistFlight = null;
      });
    }
    await active.bindingPersistFlight;
  };

  const interruptActiveTurn = async (
    active: ActiveTurn,
    starting?: StartingTurn,
  ): Promise<void> => {
    if (!active.codexTurnId || active.interruptSent) return;
    const rpc = connection;
    if (!rpc) throw new Error("Codex App Server connection is unavailable");
    active.interruptSent = true;
    if (starting) starting.interruptSent = true;
    try {
      await rpc.request(
        "turn/interrupt",
        { threadId: active.codexThreadId, turnId: active.codexTurnId },
        { retry: false },
      );
    } catch (cause) {
      active.interruptSent = false;
      if (starting) starting.interruptSent = false;
      throw cause;
    }
  };

  const rejectPendingRequestsForTurn = (
    active: ActiveTurn,
    cause: Error,
  ): void => {
    for (const [key, pending] of pendingRequests) {
      if (
        pending.projectId !== active.projectId ||
        pending.sessionId !== active.sessionId ||
        pending.grimodexTurnId !== active.grimodexTurnId
      ) {
        continue;
      }
      pendingRequests.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(cause);
    }
  };

  const failActiveTurns = (cause: unknown): void => {
    const message = cause instanceof Error ? cause.message : String(cause);
    for (const active of activeTurns.values()) {
      rejectPendingRequestsForTurn(
        active,
        new Error(
          "Codex App Server connection closed while approval was pending",
        ),
      );
      publish(active.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, {
        projectId: active.projectId,
        sessionId: active.sessionId,
        grimodexTurnId: active.grimodexTurnId,
        ...(active.codexTurnId ? { codexTurnId: active.codexTurnId } : {}),
        event: {
          type: "turn-error",
          message: `Codex App Serverとの接続が失われました: ${message}`,
          code: "CODEX_APP_SERVER_CONNECTION_CLOSED",
          retryable: false,
        },
      } satisfies CodexAppEventEnvelope);
    }
    activeTurns.clear();
  };

  const terminateAmbiguousConnection = async (
    cause: unknown,
  ): Promise<void> => {
    const currentConnection = connection;
    const currentProcess = process;
    connection = null;
    process = null;
    currentConnection?.dispose();
    const message = cause instanceof Error ? cause.message : String(cause);
    status = { ...status, state: "failed", lastError: message };
    failActiveTurns(cause);
    await currentProcess?.dispose().catch(() => {});
  };

  const setFailure = (cause: unknown): CodexAppServerError => {
    const message = cause instanceof Error ? cause.message : String(cause);
    status = { ...status, state: "failed", lastError: message };
    return new CodexAppServerError(
      `Codex App Serverとの接続に失敗しました: ${message}`,
      CODEX_APP_SERVER_PRE_TURN_CODE,
      true,
    );
  };

  const findActive = (
    projectId?: string,
    sessionId?: string,
    grimodexTurnId?: string,
    codexTurnId?: string,
    codexThreadId?: string,
  ): ActiveTurn | undefined => {
    if (projectId && sessionId && grimodexTurnId) {
      return activeTurns.get(keyFor(projectId, sessionId, grimodexTurnId));
    }
    const matches: ActiveTurn[] = [];
    for (const active of activeTurns.values()) {
      if (
        codexTurnId &&
        active.codexTurnId !== null &&
        active.codexTurnId !== codexTurnId
      ) {
        continue;
      }
      if (codexThreadId && active.codexThreadId !== codexThreadId) continue;
      if (projectId && active.projectId !== projectId) continue;
      if (sessionId && active.sessionId !== sessionId) continue;
      matches.push(active);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };

  const emitMappedNotification = (method: string, params: unknown): void => {
    const active = findActive(
      undefined,
      undefined,
      undefined,
      findTurnIdInParams(params),
      findThreadIdInParams(params),
    );
    if (!active) return;
    if (
      method === "item/started" ||
      method === "item/completed" ||
      method === "item/fileChange/patchUpdated"
    ) {
      const update = fileChangeUpdate(
        params,
        active.workspacePath,
        active.workspaceAliasPath,
      );
      if (update) active.fileChangeDetails.set(update.itemId, update.details);
    }
    const envelope = mapCodexNotification(method, params, {
      projectId: active.projectId,
      sessionId: active.sessionId,
      grimodexTurnId: active.grimodexTurnId,
      ...(active.codexTurnId ? { codexTurnId: active.codexTurnId } : {}),
    });
    if (!envelope) return;
    let bindingPersistFlight: Promise<void> | null = null;
    if (envelope.codexTurnId) {
      active.codexTurnId = envelope.codexTurnId;
      bindingPersistFlight = persistActiveBinding(active);
      void bindingPersistFlight.catch((cause) => {
        // A later notification or the start response retries this write. Keep
        // streaming events correlated even when persistence is temporarily
        // unavailable.
        if (isCodexAppServerPreTurnError(cause)) {
          void terminateAmbiguousConnection(cause);
        }
      });
      if (active.interruptRequested && !active.interruptSent) {
        void interruptActiveTurn(active).catch((cause) => {
          publish(active.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, {
            projectId: active.projectId,
            sessionId: active.sessionId,
            grimodexTurnId: active.grimodexTurnId,
            codexTurnId: active.codexTurnId ?? undefined,
            event: {
              type: "warning",
              message: `Codex turn interrupt failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          } satisfies CodexAppEventEnvelope);
        });
      }
    }
    if (
      envelope.event.type === "turn-started" ||
      envelope.event.type === "text-delta" ||
      envelope.event.type === "thinking-delta" ||
      envelope.event.type === "item-started" ||
      envelope.event.type === "item-completed"
    ) {
      active.turnStarted =
        active.turnStarted || envelope.event.type === "turn-started";
      if (envelope.event.type !== "turn-started") active.outputStarted = true;
    }
    if (envelope.event.type === "turn-completed") {
      rememberCompletedTurn(
        active,
        bindingPersistFlight ?? persistActiveBinding(active),
      );
    }
    // Commit correlation state before publishing the terminal event. A
    // renderer can immediately persist and issue the revision CAS once it
    // receives this notification.
    publish(active.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, envelope);
    if (
      envelope.event.type === "turn-completed" ||
      (envelope.event.type === "turn-error" &&
        envelope.event.retryable !== true)
    ) {
      rejectPendingRequestsForTurn(
        active,
        new Error("Codex turn ended while approval was pending"),
      );
      activeTurns.delete(
        keyFor(active.projectId, active.sessionId, active.grimodexTurnId),
      );
    }
  };

  const handleServerRequest = async (
    method: string,
    id: JsonRpcId,
    params: unknown,
  ): Promise<unknown> => {
    if (method === "item/commandExecution/requestApproval") {
      // A working directory is not a filesystem authority boundary: an exact
      // command can still read or mutate arbitrary absolute paths. Until Codex
      // exposes an enforceable workspace-scoped command sandbox, command
      // approvals must fail closed.
      throw new CodexAppServerError(
        "Codex command execution approvals are disabled in Grimodex",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    if (method !== "item/fileChange/requestApproval") {
      throw new CodexAppServerError(
        `Unsupported Codex server request denied: ${method}`,
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    const kind = "file-change" as const;
    if (!isRecord(params)) {
      throw new CodexAppServerError(
        "Codex approval params are invalid",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    const paramsRecord = params;
    const threadId = optionalApprovalString(
      paramsRecord.threadId,
      "threadId",
      MAX_ID_LENGTH,
    );
    const turnId = optionalApprovalString(
      paramsRecord.turnId,
      "turnId",
      MAX_ID_LENGTH,
    );
    if (!threadId || !turnId) {
      throw new CodexAppServerError(
        "Codex approval request has no thread or turn id",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    const active = findActive(
      undefined,
      undefined,
      undefined,
      turnId,
      threadId,
    );
    if (!active) {
      throw new CodexAppServerError(
        "Codex server request has no active Grimodex turn",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    if (!active.allowApprovals) {
      throw new CodexAppServerError(
        `Codex server request denied in read-only mode: ${method}`,
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    await assertWorkspaceStillActive(active.workspacePath);
    if (active.codexTurnId === null) active.codexTurnId = turnId;
    const itemId = optionalApprovalString(
      paramsRecord.itemId,
      "itemId",
      MAX_ID_LENGTH,
    );
    if (!itemId) {
      throw new CodexAppServerError(
        "Codex approval request has no item id",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    validateAvailableDecisions(paramsRecord);
    const summary =
      optionalApprovalString(
        paramsRecord.reason ?? paramsRecord.summary,
        "reason",
        MAX_APPROVAL_SUMMARY_CHARS,
      ) ?? method;
    let affectedPaths: string[] | undefined;
    let diff: string | undefined;
    let validateAccept: (() => void) | undefined;
    const cached = active.fileChangeDetails.get(itemId);
    if (!cached) {
      throw new CodexAppServerError(
        "Codex file-change approval has no validated change details",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    if (!cached.ok) {
      throw new CodexAppServerError(
        cached.message,
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    // Re-resolve every cached path at decision time so a safe ancestor cannot
    // be swapped for an outside-workspace symlink while the card is open.
    const paths = cached.affectedPaths.map((candidate) =>
      pathWithinWorkspace(candidate, active.workspacePath),
    );
    const grantRoot = optionalApprovalString(
      paramsRecord.grantRoot,
      "grantRoot",
      MAX_APPROVAL_COMMAND_CHARS,
    );
    if (grantRoot) {
      throw new CodexAppServerError(
        "Codex file-change approval requests unsupported session-wide write authority",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length > MAX_APPROVAL_PATHS) {
      throw new CodexAppServerError(
        "Codex file-change approval contains too many paths",
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    affectedPaths = uniquePaths;
    diff = cached.diff;
    validateAccept = async () => {
      await assertWorkspaceStillActive(active.workspacePath);
      for (const candidate of uniquePaths) {
        pathWithinWorkspace(candidate, active.workspacePath);
      }
    };
    const approvalResult = await new Promise<
      { value: unknown } | { error: Error }
    >((resolve) => {
      const key = requestKey(id);
      if (pendingRequests.has(key)) {
        resolve({ error: new Error("Duplicate Codex server request id") });
        return;
      }
      const timeout = setTimeout(() => {
        const pending = pendingRequests.get(key);
        if (!pending) return;
        pendingRequests.delete(key);
        pending.reject(new Error("Codex approval request timed out"));
      }, approvalTimeoutMs);
      pendingRequests.set(requestKey(id), {
        ownerId: active.ownerId,
        projectId: active.projectId,
        sessionId: active.sessionId,
        grimodexTurnId: active.grimodexTurnId,
        requestId: id,
        timeout,
        validateAccept,
        resolve: (value) => resolve({ value }),
        reject: (cause) => resolve({ error: cause }),
      });
      const envelope: CodexAppEventEnvelope = {
        projectId: active.projectId,
        sessionId: active.sessionId,
        grimodexTurnId: active.grimodexTurnId,
        ...(active.codexTurnId ? { codexTurnId: active.codexTurnId } : {}),
        event: {
          type: "approval-requested",
          requestId: id,
          kind,
          title: method,
          summary,
          ...(affectedPaths ? { affectedPaths } : {}),
          ...(diff ? { diff } : {}),
        },
      };
      publish(active.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, envelope);
    });
    if ("error" in approvalResult) throw approvalResult.error;
    return approvalResult.value;
  };

  const ensureReady = async (): Promise<JsonRpcConnection> => {
    if (disposed) throw new Error("Codex App Server manager is disposed");
    if (connection && status.state === "ready") return connection;
    if (!startFlight) {
      startFlight = (async () => {
        status = { ...status, state: "starting", lastError: null };
        let child: CodexAppServerProcessLike;
        try {
          child = await createProcess();
        } catch (cause) {
          if (disposed) throw cause;
          throw setFailure(cause);
        }
        if (disposed) {
          await child.dispose();
          throw new Error("Codex App Server manager is disposed");
        }
        process = child;
        try {
          await child.start();
          if (disposed) {
            throw new Error("Codex App Server manager is disposed");
          }
          const nextConnection = new JsonRpcConnection(child, {
            requestTimeoutMs: options.requestTimeoutMs,
            maxLineBytes: MAX_RPC_LINE_BYTES,
            onNotification: emitMappedNotification,
            onServerRequest: handleServerRequest,
            onClosed: (cause) => {
              if (status.state !== "closing" && !disposed) {
                status = {
                  ...status,
                  state: "failed",
                  lastError: cause?.message ?? "Codex app-server closed",
                };
                connection = null;
                if (process === child) process = null;
                void child.dispose();
                failActiveTurns(cause ?? new Error("Codex app-server closed"));
              }
            },
          });
          connection = nextConnection;
          const initializeResult = await nextConnection.request("initialize", {
            clientInfo: {
              name: "grimodex",
              title: "Grimodex",
              version: options.appVersion ?? "0.0.0",
            },
            capabilities: { experimentalApi: false },
          });
          if (disposed) {
            throw new Error("Codex App Server manager is disposed");
          }
          const serverInfo =
            isRecord(initializeResult) && isRecord(initializeResult.serverInfo)
              ? initializeResult.serverInfo
              : undefined;
          const userAgent =
            isRecord(initializeResult) &&
            typeof initializeResult.userAgent === "string"
              ? initializeResult.userAgent
              : null;
          nextConnection.notify("initialized");
          status = {
            state: "ready",
            version:
              typeof serverInfo?.version === "string"
                ? serverInfo.version
                : userAgent,
            lastError: null,
            startedAt: nowIso(now),
          };
        } catch (cause) {
          connection?.dispose();
          connection = null;
          await child.dispose();
          if (process === child) process = null;
          if (disposed) throw cause;
          throw setFailure(cause);
        }
      })().finally(() => {
        startFlight = null;
      });
    }
    await startFlight;
    if (!connection || status.state !== "ready") {
      throw setFailure(new Error("Codex App Server is not ready"));
    }
    return connection;
  };

  const archiveExternalThread = async (threadId: string): Promise<void> => {
    if (!connection) return;
    try {
      await connection.request("thread/archive", { threadId }, { retry: true });
    } catch {
      // Archive is best effort. The new binding must not be blocked by a stale
      // Codex thread that the server already forgot.
    }
  };

  const getStatus = (): CodexAppServerStatus => ({ ...status });

  const listModels = async (): Promise<CodexModel[]> => {
    const rpc = await ensureReady();
    const models = new Map<string, CodexModel>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_LIST_PAGES; page += 1) {
      const response = await rpc.request(
        "model/list",
        cursor ? { cursor } : {},
        { retry: true },
      );
      for (const model of normalizeModels(response)) {
        if (!models.has(model.id)) models.set(model.id, model);
      }
      const nextCursor = nextModelCursor(response);
      if (!nextCursor) return [...models.values()];
      if (seenCursors.has(nextCursor)) {
        throw new CodexAppServerError(
          "Codex App Server repeated a model cursor",
          "CODEX_APP_SERVER_PROTOCOL",
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new CodexAppServerError(
      "Codex App Server model list exceeded the page limit",
      "CODEX_APP_SERVER_PROTOCOL",
    );
  };

  const throwIfTurnStartInterrupted = (starting: StartingTurn): void => {
    if (starting.interruptRequested) {
      throw new CodexAppServerError(
        "Codex turn was interrupted before it started",
        "CODEX_APP_SERVER_TURN_CANCELLED",
        false,
      );
    }
  };

  const startTurnCore = async (
    input: StartCodexAppTurnPayload,
    starting: StartingTurn,
  ): Promise<{
    codexThreadId: string;
    codexTurnId: string;
    reusedThread: boolean;
  }> => {
    throwIfTurnStartInterrupted(starting);
    const workspacePath = await options.getWorkspacePath?.();
    if (!workspacePath) {
      throw new CodexAppServerError(
        "Active workspace is unavailable",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    let cwd: string;
    try {
      cwd = canonicalWorkspacePath(workspacePath);
    } catch {
      throw new CodexAppServerError(
        "Active workspace cannot be resolved",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    assertExpectedWorkspacePath(input.expectedWorkspacePath, cwd, true);
    const rpc = await ensureReady();
    throwIfTurnStartInterrupted(starting);
    await assertWorkspaceStillActive(cwd);
    const allowApprovals = options.getAllowApprovals
      ? await options.getAllowApprovals().catch(() => false)
      : options.allowApprovals === true;
    throwIfTurnStartInterrupted(starting);
    const resumedTurnInput = buildCodexTurnInput({
      ...input,
      bootstrapHistory: undefined,
    });
    if (Buffer.byteLength(resumedTurnInput, "utf8") > MAX_PACKET_BYTES) {
      throw new CodexAppServerError(
        "Codex App Server turn input exceeds the byte limit",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    let turnInput = resumedTurnInput;
    const existing = await options.threadBindings.get(
      input.projectId,
      input.sessionId,
      CODEX_APP_RUNTIME,
      cwd,
    );
    throwIfTurnStartInterrupted(starting);
    pruneCompletedTurns();
    const hasPendingCompletedTurn =
      existing !== null &&
      [...completedTurns.values()].some(
        (receipt) =>
          receipt.projectId === input.projectId &&
          receipt.sessionId === input.sessionId &&
          receipt.codexThreadId === existing.externalThreadId &&
          receipt.historyRevision === existing.historyRevision &&
          receipt.advancedHistoryRevision === null,
      );
    let threadId: string | null = null;
    let reusedThread = false;
    if (
      existing &&
      existing.historyRevision === input.historyRevision &&
      !hasPendingCompletedTurn
    ) {
      try {
        await assertWorkspaceStillActive(cwd);
        const resumed = await rpc.request(
          "thread/resume",
          {
            threadId: existing.externalThreadId,
            cwd,
            ...(input.model ? { model: input.model } : {}),
            sandbox: "read-only",
            approvalPolicy: allowApprovals ? "on-request" : "never",
            developerInstructions: instructionsForTurn(allowApprovals),
          },
          { retry: true },
        );
        const resumedThreadId = extractThreadId(resumed);
        if (resumedThreadId && resumedThreadId !== existing.externalThreadId) {
          throw new CodexAppServerError(
            "Codex App Server resumed an unexpected thread",
            "CODEX_APP_SERVER_PROTOCOL",
            true,
          );
        }
        threadId = existing.externalThreadId;
        reusedThread = true;
        await assertWorkspaceStillActive(cwd);
        throwIfTurnStartInterrupted(starting);
      } catch (cause) {
        if (cause instanceof CodexAppServerError) throw cause;
        await archiveExternalThread(existing.externalThreadId);
        throwIfTurnStartInterrupted(starting);
      }
    } else if (existing) {
      await archiveExternalThread(existing.externalThreadId);
      throwIfTurnStartInterrupted(starting);
    }
    if (!threadId) {
      turnInput = buildCodexTurnInput(input);
      if (Buffer.byteLength(turnInput, "utf8") > MAX_PACKET_BYTES) {
        throw new CodexAppServerError(
          "Codex App Server turn input exceeds the byte limit",
          CODEX_APP_SERVER_PRE_TURN_CODE,
          true,
        );
      }
      const mcpServer = options.getReadOnlyMcpServer
        ? await options
            .getReadOnlyMcpServer(input.projectId, cwd)
            .catch((cause) => {
              publish(starting.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, {
                projectId: input.projectId,
                sessionId: input.sessionId,
                grimodexTurnId: input.grimodexTurnId,
                event: {
                  type: "warning",
                  message: `Read-only MCP is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
                },
              } satisfies CodexAppEventEnvelope);
              return null;
            })
        : null;
      throwIfTurnStartInterrupted(starting);
      await assertWorkspaceStillActive(cwd);
      const threadStartParams = {
        cwd,
        ...(input.model ? { model: input.model } : {}),
        // Keep the base sandbox read-only even when approval cards are enabled.
        // A specific accepted server request is the only authority escalation.
        sandbox: "read-only",
        approvalPolicy: allowApprovals ? "on-request" : "never",
        developerInstructions: instructionsForTurn(allowApprovals),
        ephemeral: false,
        ...(mcpServer
          ? {
              config: {
                mcp_servers: {
                  grimodex: {
                    command: mcpServer.command,
                    args: mcpServer.args,
                    env: mcpServer.env ?? {},
                  },
                },
              },
            }
          : {}),
      };
      let started: unknown;
      try {
        started = await rpc.request("thread/start", threadStartParams, {
          retry: false,
        });
      } catch (cause) {
        // Older app-server versions may reject the optional MCP field. A
        // thread has not started yet, so retrying without MCP is safe and
        // keeps the read-only Chat transport usable across versions.
        if (!mcpServer || !canRetryThreadStartWithoutMcp(cause)) throw cause;
        publish(starting.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, {
          projectId: input.projectId,
          sessionId: input.sessionId,
          grimodexTurnId: input.grimodexTurnId,
          event: {
            type: "warning",
            message:
              "Codex App ServerはMCP設定を受け付けないため、MCPなしで続行します。",
          },
        } satisfies CodexAppEventEnvelope);
        const withoutMcp = { ...threadStartParams } as Record<string, unknown>;
        delete withoutMcp.config;
        started = await rpc.request("thread/start", withoutMcp, {
          retry: false,
        });
      }
      threadId = extractThreadId(started);
      if (!threadId) {
        throw new CodexAppServerError(
          "Codex App Server returned no thread id",
          CODEX_APP_SERVER_PRE_TURN_CODE,
          true,
        );
      }
      if (starting.interruptRequested) {
        await archiveExternalThread(threadId);
        throwIfTurnStartInterrupted(starting);
      }
      try {
        await assertWorkspaceStillActive(cwd);
      } catch (cause) {
        await archiveExternalThread(threadId);
        throw cause;
      }
    }
    const timestamp = nowIso(now);
    const binding: CodexRuntimeThreadBinding = {
      sessionId: input.sessionId,
      runtime: CODEX_APP_RUNTIME,
      externalThreadId: threadId,
      projectId: input.projectId,
      historyRevision: pendingHistoryRevisionFor(input.grimodexTurnId),
      lastTurnId: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    throwIfTurnStartInterrupted(starting);
    await assertWorkspaceStillActive(cwd);
    try {
      // Durably make this thread non-resumable before turn/start can be
      // accepted. If the renderer or app dies before the completion CAS, a
      // later manager sees the sentinel and starts from local history instead
      // of resuming remote context that the local DB never committed.
      await options.threadBindings.upsert(binding, cwd);
      throwIfTurnStartInterrupted(starting);
      await assertWorkspaceStillActive(cwd);
    } catch (cause) {
      // A newly-created empty thread is best-effort cleanup only. The binding
      // failure itself remains a proven pre-turn outcome and is therefore safe
      // for renderer-side transport fallback.
      if (!reusedThread) void archiveExternalThread(threadId).catch(() => {});
      throw cause;
    }

    const active: ActiveTurn = {
      ownerId: starting.ownerId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      grimodexTurnId: input.grimodexTurnId,
      codexThreadId: threadId,
      codexTurnId: null,
      workspacePath: cwd,
      workspaceAliasPath: path.resolve(workspacePath),
      allowApprovals,
      turnStarted: false,
      outputStarted: false,
      interruptRequested: starting.interruptRequested,
      interruptSent: starting.interruptSent,
      binding,
      bindingPersisted: false,
      bindingPersistFlight: null,
      historyRevision: input.historyRevision,
      fileChangeDetails: new Map(),
    };
    activeTurns.set(
      keyFor(input.projectId, input.sessionId, input.grimodexTurnId),
      active,
    );
    // A real server may emit thread/started before its thread/start response;
    // that notification has no active-turn context yet and is intentionally
    // dropped. Re-emit the authoritative binding after registration so the
    // renderer can persist the external thread id in assistant metadata.
    publish(active.ownerId, CODEX_APP_SERVER_EVENT_CHANNEL, {
      projectId: active.projectId,
      sessionId: active.sessionId,
      grimodexTurnId: active.grimodexTurnId,
      event: { type: "thread-started", threadId: active.codexThreadId },
    } satisfies CodexAppEventEnvelope);
    try {
      // From this point a transport failure is ambiguous: the server may have
      // accepted the turn even when its response never reached main. Never
      // classify such failures as safe for renderer-side fallback.
      starting.turnStartDispatched = true;
      const result = await rpc.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: turnInput }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          approvalPolicy: active.allowApprovals ? "on-request" : "never",
          clientUserMessageId: input.clientUserMessageId,
        },
        { retry: false },
      );
      const responseTurnId = extractTurnId(result);
      if (
        responseTurnId &&
        active.codexTurnId &&
        responseTurnId !== active.codexTurnId
      ) {
        throw new CodexAppServerError(
          "Codex App Server returned conflicting turn ids",
          "CODEX_APP_SERVER_PROTOCOL",
          false,
        );
      }
      const codexTurnId = responseTurnId ?? active.codexTurnId;
      if (!codexTurnId) {
        throw new CodexAppServerError(
          "Codex App Server returned no turn id",
          "CODEX_APP_SERVER_PROTOCOL",
          false,
        );
      }
      active.codexTurnId = codexTurnId;
      active.interruptRequested ||= starting.interruptRequested;
      if (active.interruptRequested) {
        await interruptActiveTurn(active, starting);
      }
      await persistActiveBinding(active);
      return { codexThreadId: threadId, codexTurnId, reusedThread };
    } catch (cause) {
      const hasAuthoritativeTurnEvidence =
        active.codexTurnId !== null ||
        active.turnStarted ||
        active.outputStarted;
      if (
        cause instanceof JsonRpcRemoteError &&
        !hasAuthoritativeTurnEvidence
      ) {
        activeTurns.delete(
          keyFor(input.projectId, input.sessionId, input.grimodexTurnId),
        );
        if (reusedThread && existing) {
          // A JSON-RPC error response with no turn notification is a definitive
          // rejection. Restore the committed row that prebinding replaced so a
          // restart can still resume the unchanged external thread.
          await options.threadBindings.upsert(existing, cwd);
        } else {
          // No turn was accepted, so both the newly-created empty thread and
          // its pending row are safe to discard. Cleanup stays best-effort;
          // retaining the sentinel is still fail-closed if either step fails.
          await archiveExternalThread(threadId);
          await options.threadBindings
            .delete(input.projectId, input.sessionId, CODEX_APP_RUNTIME, cwd)
            .catch(() => {});
        }
      } else {
        // Once turn/start is on the wire, timeouts and local persistence
        // failures are ambiguous. A remote error is also ambiguous when an
        // authoritative notification already proved that the turn exists.
        // Preserve correlation so later notifications remain visible and Stop
        // can still interrupt the exact turn.
        active.interruptRequested = true;
        if (active.codexTurnId) {
          await persistActiveBinding(active).catch(() => {});
          if (!active.interruptSent) {
            try {
              await interruptActiveTurn(active);
            } catch {
              await terminateAmbiguousConnection(cause);
            }
          }
        } else {
          await terminateAmbiguousConnection(cause);
        }
      }
      if (cause instanceof CodexAppServerError && !cause.preTurn) throw cause;
      throw new CodexAppServerError(
        cause instanceof Error ? cause.message : String(cause),
        "CODEX_APP_SERVER_TURN_FAILED",
        false,
      );
    }
  };

  const startTurn = async (
    input: StartCodexAppTurnPayload,
    ownerId: number | null = null,
  ): Promise<{
    codexThreadId: string;
    codexTurnId: string;
    reusedThread: boolean;
  }> => {
    if (isPendingHistoryRevision(input.historyRevision)) {
      throw new CodexAppServerError(
        "Codex history revision uses a reserved internal prefix",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    const turnKey = keyFor(
      input.projectId,
      input.sessionId,
      input.grimodexTurnId,
    );
    if (startingTurns.has(turnKey) || activeTurns.has(turnKey)) {
      throw new CodexAppServerError(
        "Codex turn is already starting or active",
        "CODEX_APP_SERVER_TURN_ACTIVE",
        false,
      );
    }
    const starting: StartingTurn = {
      ownerId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      grimodexTurnId: input.grimodexTurnId,
      interruptRequested: false,
      interruptSent: false,
      turnStartDispatched: false,
    };
    startingTurns.set(turnKey, starting);
    try {
      return await withSessionOperation(
        input.projectId,
        input.sessionId,
        async () => {
          pruneCompletedTurns();
          if (completedTurns.has(turnKey)) {
            throw new CodexAppServerError(
              "Codex turn id was already completed",
              "CODEX_APP_SERVER_TURN_ACTIVE",
              false,
            );
          }
          const sessionHasActiveTurn = [...activeTurns.values()].some(
            (active) =>
              active.projectId === input.projectId &&
              active.sessionId === input.sessionId,
          );
          if (sessionHasActiveTurn) {
            throw new CodexAppServerError(
              "Codex session already has an active turn",
              "CODEX_APP_SERVER_TURN_ACTIVE",
              false,
            );
          }
          return startTurnCore(input, starting);
        },
      );
    } catch (cause) {
      if (cause instanceof CodexAppServerError) throw cause;
      const preTurn = !starting.turnStartDispatched;
      throw new CodexAppServerError(
        cause instanceof Error ? cause.message : String(cause),
        preTurn
          ? CODEX_APP_SERVER_PRE_TURN_CODE
          : "CODEX_APP_SERVER_TURN_FAILED",
        preTurn,
      );
    } finally {
      startingTurns.delete(turnKey);
    }
  };

  const interruptTurn = async (
    input: InterruptCodexAppTurnPayload,
    ownerId: number | null = null,
  ): Promise<void> => {
    const turnKey = keyFor(
      input.projectId,
      input.sessionId,
      input.grimodexTurnId,
    );
    const starting = startingTurns.get(turnKey);
    if (starting) {
      assertOwner(starting.ownerId, ownerId);
      starting.interruptRequested = true;
    }
    const active = activeTurns.get(turnKey);
    if (active) {
      assertOwner(active.ownerId, ownerId);
      active.interruptRequested = true;
    }
    if (!active?.codexTurnId) {
      if (starting || active) return;
      throw new Error("Codex turn is not active or has no turn id");
    }
    if (active.interruptSent) return;
    await ensureReady();
    await interruptActiveTurn(active, starting);
  };

  const advanceHistoryRevision = async (
    input: AdvanceCodexHistoryRevisionPayload,
    ownerId: number | null = null,
  ): Promise<AdvanceCodexHistoryRevisionResult> => {
    for (const [field, value] of Object.entries(input)) {
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAX_ID_LENGTH
      ) {
        throw new Error(`Invalid Codex history revision field: ${field}`);
      }
    }
    if (input.expectedHistoryRevision === input.nextHistoryRevision) {
      throw new Error("Codex history revision did not advance");
    }
    if (
      isPendingHistoryRevision(input.expectedHistoryRevision) ||
      isPendingHistoryRevision(input.nextHistoryRevision)
    ) {
      throw new Error("Codex history revision uses a reserved internal prefix");
    }
    return withSessionOperation(input.projectId, input.sessionId, async () => {
      pruneCompletedTurns();
      const turnKey = keyFor(
        input.projectId,
        input.sessionId,
        input.grimodexTurnId,
      );
      const receipt = completedTurns.get(turnKey);
      if (
        !receipt ||
        receipt.projectId !== input.projectId ||
        receipt.sessionId !== input.sessionId ||
        receipt.grimodexTurnId !== input.grimodexTurnId ||
        receipt.codexThreadId !== input.codexThreadId ||
        receipt.codexTurnId !== input.codexTurnId ||
        receipt.historyRevision !== input.expectedHistoryRevision
      ) {
        throw new Error("Codex completed turn receipt is missing or stale");
      }
      assertOwner(receipt.ownerId, ownerId);
      // A completion notification may arrive before the turn/start response.
      // The receipt is authoritative only after the pending binding's turn id
      // has reached the native DB; otherwise CAS can observe a false stale miss.
      await receipt.bindingPersistFlight;
      await assertWorkspaceStillActive(receipt.workspacePath);
      if (receipt.advancedHistoryRevision === input.nextHistoryRevision) {
        return { status: "already-advanced" };
      }
      if (receipt.advancedHistoryRevision !== null) {
        throw new Error("Codex completed turn receipt was already advanced");
      }

      const advanced = await options.threadBindings.advanceHistoryRevision({
        expectedWorkspacePath: receipt.workspacePath,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runtime: CODEX_APP_RUNTIME,
        externalThreadId: input.codexThreadId,
        lastTurnId: input.codexTurnId,
        pendingHistoryRevision: pendingHistoryRevisionFor(
          receipt.grimodexTurnId,
        ),
        nextHistoryRevision: input.nextHistoryRevision,
        updatedAt: nowIso(now),
      });
      if (advanced) {
        receipt.advancedHistoryRevision = input.nextHistoryRevision;
        return { status: "advanced" };
      }

      const current = await options.threadBindings.get(
        input.projectId,
        input.sessionId,
        CODEX_APP_RUNTIME,
        receipt.workspacePath,
      );
      if (
        current?.externalThreadId === input.codexThreadId &&
        current.lastTurnId === input.codexTurnId &&
        current.historyRevision === input.nextHistoryRevision
      ) {
        receipt.advancedHistoryRevision = input.nextHistoryRevision;
        return { status: "already-advanced" };
      }
      throw new Error("Codex history revision compare-and-swap was stale");
    });
  };

  const respondToServerRequest = async (
    input: RespondCodexServerRequestPayload,
    ownerId: number | null = null,
  ): Promise<void> => {
    const id = parseServerRequestId(input.requestId);
    const key = requestKey(id);
    const pending = pendingRequests.get(key);
    if (!pending) throw new Error("Unknown Codex server request id");
    assertOwner(pending.ownerId, ownerId);
    if (
      pending.projectId !== input.projectId ||
      pending.sessionId !== input.sessionId ||
      pending.grimodexTurnId !== input.grimodexTurnId
    ) {
      throw new Error("Codex server request authority mismatch");
    }
    if (input.decision === "accept" && pending.validateAccept) {
      try {
        await pending.validateAccept();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        if (pendingRequests.get(key) === pending) {
          pendingRequests.delete(key);
          clearTimeout(pending.timeout);
          pending.reject(error);
        } else {
          throw new Error("Codex server request is no longer pending");
        }
        throw error;
      }
    }
    // Validation yields to the event loop. A timeout, terminal turn event,
    // owner destruction, or a competing decline may have consumed the request
    // while the filesystem authority was being rechecked.
    if (pendingRequests.get(key) !== pending) {
      throw new Error("Codex server request is no longer pending");
    }
    pendingRequests.delete(key);
    clearTimeout(pending.timeout);
    pending.resolve({ decision: input.decision });
  };

  const archiveSessionThread = async (
    input: ArchiveCodexSessionThreadPayload,
  ): Promise<void> =>
    withSessionOperation(input.projectId, input.sessionId, async () => {
      const { projectId, sessionId } = input;
      const hasLiveTurn =
        [...startingTurns.values()].some(
          (turn) =>
            turn.projectId === projectId && turn.sessionId === sessionId,
        ) ||
        [...activeTurns.values()].some(
          (turn) =>
            turn.projectId === projectId && turn.sessionId === sessionId,
        );
      if (hasLiveTurn) {
        throw new CodexAppServerError(
          "Cannot archive a Codex session while its turn is active",
          "CODEX_APP_SERVER_TURN_ACTIVE",
          false,
        );
      }
      const currentWorkspace = await options.getWorkspacePath?.();
      if (!currentWorkspace) throw new Error("Active workspace is unavailable");
      const expectedWorkspacePath = canonicalWorkspacePath(currentWorkspace);
      assertExpectedWorkspacePath(
        input.expectedWorkspacePath,
        expectedWorkspacePath,
        false,
      );
      const binding = await options.threadBindings.get(
        projectId,
        sessionId,
        CODEX_APP_RUNTIME,
        expectedWorkspacePath,
      );
      if (!binding) return;
      const rpc = await ensureReady();
      await assertWorkspaceStillActive(expectedWorkspacePath);
      await rpc.request(
        "thread/archive",
        { threadId: binding.externalThreadId },
        { retry: true },
      );
      await options.threadBindings.delete(
        projectId,
        sessionId,
        CODEX_APP_RUNTIME,
        expectedWorkspacePath,
      );
      for (const [key, receipt] of completedTurns) {
        if (
          receipt.projectId === projectId &&
          receipt.sessionId === sessionId
        ) {
          completedTurns.delete(key);
        }
      }
    });

  const setThreadName = async (
    input: SetCodexThreadNamePayload,
  ): Promise<void> => {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 256) {
      throw new Error("Codex thread name must be between 1 and 256 characters");
    }
    const currentWorkspace = await options.getWorkspacePath?.();
    if (!currentWorkspace) throw new Error("Active workspace is unavailable");
    const expectedWorkspacePath = canonicalWorkspacePath(currentWorkspace);
    assertExpectedWorkspacePath(
      input.expectedWorkspacePath,
      expectedWorkspacePath,
      false,
    );
    const binding = await options.threadBindings.get(
      input.projectId,
      input.sessionId,
      CODEX_APP_RUNTIME,
      expectedWorkspacePath,
    );
    if (!binding) return;
    const rpc = await ensureReady();
    await assertWorkspaceStillActive(expectedWorkspacePath);
    await rpc.request(
      "thread/name/set",
      { threadId: binding.externalThreadId, name },
      { retry: true },
    );
  };

  const handleWorkspaceChanged = async (): Promise<void> => {
    for (const starting of startingTurns.values()) {
      starting.interruptRequested = true;
    }
    completedTurns.clear();
    if (activeTurns.size > 0) {
      await terminateAmbiguousConnection(
        new Error("Active workspace changed during a Codex turn"),
      );
    }
  };

  const handleOwnerDestroyed = async (ownerId: number): Promise<void> => {
    for (const starting of startingTurns.values()) {
      if (starting.ownerId === ownerId) starting.interruptRequested = true;
    }
    for (const [key, receipt] of completedTurns) {
      if (receipt.ownerId === ownerId) completedTurns.delete(key);
    }
    const ownsActiveTurn = [...activeTurns.values()].some(
      (active) => active.ownerId === ownerId,
    );
    if (ownsActiveTurn) {
      await terminateAmbiguousConnection(
        new Error("Codex turn owner renderer was destroyed"),
      );
      return;
    }
    for (const [key, pending] of pendingRequests) {
      if (pending.ownerId !== ownerId) continue;
      pendingRequests.delete(key);
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex approval owner renderer was destroyed"));
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    status = { ...status, state: "closing" };
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex App Server manager disposed"));
    }
    pendingRequests.clear();
    connection?.dispose();
    connection = null;
    const flight = startFlight;
    const currentProcess = process;
    await currentProcess?.dispose();
    await flight?.catch(() => {});
    if (process && process !== currentProcess) await process.dispose();
    process = null;
    activeTurns.clear();
    startingTurns.clear();
    completedTurns.clear();
    status = { ...status, state: "stopped" };
  };

  const createHandlers = (ownerId: number | null): ShellCommandHandlers => ({
    codex_app_get_status: async () => getStatus(),
    codex_app_test_connection: async () => {
      await ensureReady();
      return getStatus();
    },
    codex_app_list_models: async () => listModels(),
    codex_app_start_turn: async (args): Promise<StartCodexAppTurnResult> => {
      const input: StartCodexAppTurnPayload = {
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        expectedWorkspacePath: workspacePathString(
          args,
          "expectedWorkspacePath",
        ),
        grimodexTurnId: requiredString(args, "grimodexTurnId"),
        clientUserMessageId: requiredString(args, "clientUserMessageId"),
        model: optionalString(args, "model"),
        effort: optionalString(args, "effort"),
        contextPacket: packetString(args, "contextPacket"),
        bootstrapHistory: optionalPacketString(args, "bootstrapHistory"),
        historyRevision: requiredString(args, "historyRevision"),
        userMessage: packetString(args, "userMessage"),
      };
      try {
        const started = await startTurn(input, ownerId);
        return { status: "started", ...started };
      } catch (cause) {
        if (!isCodexAppServerPreTurnError(cause)) throw cause;
        return {
          status: "rejected-before-turn",
          code: cause.code,
          message: cause.message,
        };
      }
    },
    codex_app_interrupt_turn: async (args) => {
      await interruptTurn(
        {
          projectId: requiredString(args, "projectId"),
          sessionId: requiredString(args, "sessionId"),
          grimodexTurnId: requiredString(args, "grimodexTurnId"),
        },
        ownerId,
      );
      return null;
    },
    codex_app_update_history_revision: async (args) =>
      advanceHistoryRevision(
        {
          projectId: requiredString(args, "projectId"),
          sessionId: requiredString(args, "sessionId"),
          grimodexTurnId: requiredString(args, "grimodexTurnId"),
          codexThreadId: requiredString(args, "codexThreadId"),
          codexTurnId: requiredString(args, "codexTurnId"),
          expectedHistoryRevision: requiredString(
            args,
            "expectedHistoryRevision",
          ),
          nextHistoryRevision: requiredString(args, "nextHistoryRevision"),
        },
        ownerId,
      ),
    codex_app_respond_to_request: async (args) => {
      const decision = args.decision;
      if (decision !== "accept" && decision !== "decline") {
        throw new Error("invalid args `decision`: expected accept or decline");
      }
      await respondToServerRequest(
        {
          projectId: requiredString(args, "projectId"),
          sessionId: requiredString(args, "sessionId"),
          grimodexTurnId: requiredString(args, "grimodexTurnId"),
          requestId: parseServerRequestId(args.requestId),
          decision,
        },
        ownerId,
      );
      return null;
    },
    codex_app_archive_session_thread: async (args) => {
      await archiveSessionThread({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        expectedWorkspacePath: workspacePathString(
          args,
          "expectedWorkspacePath",
        ),
      });
      return null;
    },
    codex_app_set_thread_name: async (args) => {
      await setThreadName({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        expectedWorkspacePath: workspacePathString(
          args,
          "expectedWorkspacePath",
        ),
        name: packetString(args, "name"),
      });
      return null;
    },
  });

  const handlers = createHandlers(null);

  return {
    handlers,
    handlersForOwner: (ownerId) => createHandlers(ownerId),
    getStatus,
    listModels,
    startTurn,
    interruptTurn,
    advanceHistoryRevision,
    respondToServerRequest,
    archiveSessionThread,
    setThreadName,
    handleWorkspaceChanged,
    handleOwnerDestroyed,
    dispose,
  };
}
