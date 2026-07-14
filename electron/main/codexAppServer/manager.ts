import type {
  CommandArgs,
  ShellCommandHandlers,
} from "../../shared/ipcContract.js";
import {
  buildCodexTurnInput,
  type CodexAppEventEnvelope,
  type CodexAppServerStatus,
  type CodexModel,
  type CodexRuntimeThreadBinding,
  type InterruptCodexAppTurnPayload,
  type JsonRpcId,
  type RespondCodexServerRequestPayload,
  type SetCodexThreadNamePayload,
  type StartCodexAppTurnPayload,
} from "../../shared/codexAppProtocol.js";
import { mapCodexNotification } from "./eventMapper.js";
import path from "node:path";

import { JsonRpcConnection, JsonRpcRemoteError } from "./jsonRpcConnection.js";
import { CodexAppServerProcess } from "./process.js";
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
const MAX_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_RPC_LINE_BYTES = MAX_PACKET_BYTES + 512 * 1024;
const GRIMODEX_READ_ONLY_INSTRUCTIONS = [
  "You are operating inside Grimodex.",
  "The newest <grimodex-context> block is authoritative.",
  "The initial release is read-only: do not modify files, execute commands, or call write tools.",
  "Answer only the newest <user-request>.",
].join("\n");

const GRIMODEX_APPROVAL_INSTRUCTIONS = [
  "You are operating inside Grimodex.",
  "The newest <grimodex-context> block is authoritative.",
  "Workspace writes and commands are allowed only after the user approves the exact request in Grimodex.",
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
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  codexThreadId: string;
  codexTurnId: string | null;
  workspacePath: string;
  allowApprovals: boolean;
  turnStarted: boolean;
  outputStarted: boolean;
}

interface PendingServerRequest {
  projectId: string;
  sessionId: string;
  grimodexTurnId: string;
  requestId: JsonRpcId;
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
  createProcess?: () =>
    | CodexAppServerProcessLike
    | Promise<CodexAppServerProcessLike>;
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
  ) => Promise<CodexMcpServerConfig | null>;
  requestTimeoutMs?: number;
}

export interface CodexAppServerManager {
  readonly handlers: ShellCommandHandlers;
  getStatus(): CodexAppServerStatus;
  listModels(): Promise<CodexModel[]>;
  startTurn(input: StartCodexAppTurnPayload): Promise<{
    codexThreadId: string;
    codexTurnId: string;
    reusedThread: boolean;
  }>;
  interruptTurn(input: InterruptCodexAppTurnPayload): Promise<void>;
  respondToServerRequest(
    input: RespondCodexServerRequestPayload,
  ): Promise<void>;
  archiveSessionThread(projectId: string, sessionId: string): Promise<void>;
  setThreadName(input: SetCodexThreadNamePayload): Promise<void>;
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

export function isCodexAppServerPreTurnError(value: unknown): boolean {
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

function keyFor(
  projectId: string,
  sessionId: string,
  grimodexTurnId: string,
): string {
  return `${projectId}\u0000${sessionId}\u0000${grimodexTurnId}`;
}

function requestKey(requestId: JsonRpcId): string {
  return typeof requestId === "number" ? `n:${requestId}` : `s:${requestId}`;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

const MAX_APPROVAL_COMMAND_PARTS = 128;
const MAX_APPROVAL_PATHS = 256;
const MAX_APPROVAL_DIFF_CHARS = 512 * 1024;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function boundedStringArray(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  return values.length > 0 ? values.slice(0, max) : undefined;
}

function pathWithinWorkspace(rawPath: string, workspacePath: string): string {
  const workspace = path.resolve(workspacePath);
  const candidate = path.resolve(workspace, rawPath);
  const relative = path.relative(workspace, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new CodexAppServerError(
      "Codex approval references a path outside the active workspace",
      CODEX_APP_SERVER_REQUEST_DENIED_CODE,
    );
  }
  return relative || ".";
}

function approvalPaths(
  params: Record<string, unknown>,
  workspacePath: string,
): string[] | undefined {
  const rawPaths = [
    ...(boundedStringArray(params.affectedPaths, MAX_APPROVAL_PATHS) ?? []),
    ...(boundedStringArray(params.paths, MAX_APPROVAL_PATHS) ?? []),
    ...(boundedStringArray(params.files, MAX_APPROVAL_PATHS) ?? []),
    ...(typeof params.path === "string" ? [params.path] : []),
  ];
  if (typeof params.cwd === "string") {
    pathWithinWorkspace(params.cwd, workspacePath);
  }
  if (rawPaths.length === 0) return undefined;
  const normalized = rawPaths.map((value) =>
    pathWithinWorkspace(value, workspacePath),
  );
  return [...new Set(normalized)].slice(0, MAX_APPROVAL_PATHS);
}

function canRetryThreadStartWithoutMcp(cause: unknown): boolean {
  if (!(cause instanceof JsonRpcRemoteError)) return false;
  return (
    cause.code === -32601 ||
    cause.code === -32602 ||
    /mcp|unknown|invalid params|additional properties|unrecognized/i.test(
      cause.message,
    )
  );
}

export function createCodexAppServerManager(
  options: CodexAppServerManagerOptions,
): CodexAppServerManager {
  const now = options.now ?? (() => new Date());
  const broadcast = options.broadcast ?? (() => {});
  const createProcess =
    options.createProcess ?? (() => new CodexAppServerProcess());
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
  const pendingRequests = new Map<string, PendingServerRequest>();

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
      broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, {
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
    for (const active of activeTurns.values()) {
      if (codexTurnId && active.codexTurnId !== codexTurnId) continue;
      if (codexThreadId && active.codexThreadId !== codexThreadId) continue;
      if (projectId && active.projectId !== projectId) continue;
      if (sessionId && active.sessionId !== sessionId) continue;
      return active;
    }
    return !projectId &&
      !sessionId &&
      !grimodexTurnId &&
      !codexTurnId &&
      !codexThreadId &&
      activeTurns.size === 1
      ? activeTurns.values().next().value
      : undefined;
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
    const envelope = mapCodexNotification(method, params, {
      projectId: active.projectId,
      sessionId: active.sessionId,
      grimodexTurnId: active.grimodexTurnId,
      ...(active.codexTurnId ? { codexTurnId: active.codexTurnId } : {}),
    });
    if (!envelope) return;
    if (envelope.codexTurnId) active.codexTurnId = envelope.codexTurnId;
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
    broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, envelope);
    if (
      envelope.event.type === "turn-completed" ||
      envelope.event.type === "turn-error"
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
    const active = findActive(
      undefined,
      undefined,
      undefined,
      findTurnIdInParams(params),
      findThreadIdInParams(params),
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
    const lowerMethod = method.toLowerCase();
    const kind: "command" | "file-change" | "permission" | "user-input" =
      lowerMethod.includes("file")
        ? "file-change"
        : lowerMethod.includes("command")
          ? "command"
          : lowerMethod.includes("input") || lowerMethod.includes("elicitation")
            ? "user-input"
            : "permission";
    if (
      !/(approval|command|file|permission|input|elicitation|dynamic.?tool)/i.test(
        method,
      )
    ) {
      throw new CodexAppServerError(
        `Unsupported Codex server request denied: ${method}`,
        CODEX_APP_SERVER_REQUEST_DENIED_CODE,
      );
    }
    const paramsRecord = isRecord(params) ? params : {};
    const affectedPaths = approvalPaths(paramsRecord, active.workspacePath);
    const command =
      boundedStringArray(paramsRecord.command, MAX_APPROVAL_COMMAND_PARTS) ??
      boundedStringArray(paramsRecord.argv, MAX_APPROVAL_COMMAND_PARTS);
    const diff = boundedString(
      paramsRecord.diff ?? paramsRecord.patch,
      MAX_APPROVAL_DIFF_CHARS,
    );
    const approvalResult = await new Promise<
      { value: unknown } | { error: Error }
    >((resolve) => {
      const key = requestKey(id);
      if (pendingRequests.has(key)) {
        resolve({ error: new Error("Duplicate Codex server request id") });
        return;
      }
      pendingRequests.set(requestKey(id), {
        projectId: active.projectId,
        sessionId: active.sessionId,
        grimodexTurnId: active.grimodexTurnId,
        requestId: id,
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
          summary: boundedString(paramsRecord.summary, 8 * 1024) ?? method,
          ...(command ? { command } : {}),
          ...(affectedPaths ? { affectedPaths } : {}),
          ...(diff ? { diff } : {}),
        },
      };
      broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, envelope);
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
        const child = await createProcess();
        process = child;
        try {
          await child.start();
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
          const serverInfo =
            isRecord(initializeResult) && isRecord(initializeResult.serverInfo)
              ? initializeResult.serverInfo
              : undefined;
          nextConnection.notify("initialized");
          status = {
            state: "ready",
            version:
              typeof serverInfo?.version === "string"
                ? serverInfo.version
                : null,
            lastError: null,
            startedAt: nowIso(now),
          };
        } catch (cause) {
          connection?.dispose();
          connection = null;
          await child.dispose();
          process = null;
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
    return normalizeModels(
      await rpc.request("model/list", {}, { retry: true }),
    );
  };

  const startTurn = async (
    input: StartCodexAppTurnPayload,
  ): Promise<{
    codexThreadId: string;
    codexTurnId: string;
    reusedThread: boolean;
  }> => {
    const rpc = await ensureReady();
    const cwd = await options.getWorkspacePath?.();
    if (!cwd) {
      throw new CodexAppServerError(
        "Active workspace is unavailable",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    const allowApprovals = options.getAllowApprovals
      ? await options.getAllowApprovals().catch(() => false)
      : options.allowApprovals === true;
    const turnInput = buildCodexTurnInput(input);
    if (Buffer.byteLength(turnInput, "utf8") > MAX_PACKET_BYTES) {
      throw new CodexAppServerError(
        "Codex App Server turn input exceeds the byte limit",
        CODEX_APP_SERVER_PRE_TURN_CODE,
        true,
      );
    }
    const existing = await options.threadBindings.get(
      input.projectId,
      input.sessionId,
      CODEX_APP_RUNTIME,
    );
    let threadId: string | null = null;
    let reusedThread = false;
    if (existing && existing.historyRevision === input.historyRevision) {
      try {
        const resumed = await rpc.request(
          "thread/resume",
          { threadId: existing.externalThreadId },
          { retry: true },
        );
        threadId = extractThreadId(resumed) ?? existing.externalThreadId;
        reusedThread = true;
      } catch {
        await archiveExternalThread(existing.externalThreadId);
      }
    } else if (existing) {
      await archiveExternalThread(existing.externalThreadId);
    }
    if (!threadId) {
      const mcpServer = options.getReadOnlyMcpServer
        ? await options.getReadOnlyMcpServer(input.projectId).catch((cause) => {
            broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, {
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
      const threadStartParams = {
        cwd,
        ...(input.model ? { model: input.model } : {}),
        sandbox: allowApprovals ? "workspace-write" : "read-only",
        approvalPolicy: allowApprovals ? "on-request" : "never",
        developerInstructions: instructionsForTurn(allowApprovals),
        ephemeral: false,
        ...(mcpServer
          ? {
              mcpServers: {
                grimodex: {
                  command: mcpServer.command,
                  args: mcpServer.args,
                  env: mcpServer.env ?? {},
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
        broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, {
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
        delete withoutMcp.mcpServers;
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
    }
    const timestamp = nowIso(now);
    const binding: CodexRuntimeThreadBinding = {
      sessionId: input.sessionId,
      runtime: CODEX_APP_RUNTIME,
      externalThreadId: threadId,
      projectId: input.projectId,
      historyRevision: input.historyRevision,
      lastTurnId: null,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    await options.threadBindings.upsert(binding);

    const active: ActiveTurn = {
      projectId: input.projectId,
      sessionId: input.sessionId,
      grimodexTurnId: input.grimodexTurnId,
      codexThreadId: threadId,
      codexTurnId: null,
      workspacePath: cwd,
      allowApprovals,
      turnStarted: false,
      outputStarted: false,
    };
    activeTurns.set(
      keyFor(input.projectId, input.sessionId, input.grimodexTurnId),
      active,
    );
    // A real server may emit thread/started before its thread/start response;
    // that notification has no active-turn context yet and is intentionally
    // dropped. Re-emit the authoritative binding after registration so the
    // renderer can persist the external thread id in assistant metadata.
    broadcast(CODEX_APP_SERVER_EVENT_CHANNEL, {
      projectId: active.projectId,
      sessionId: active.sessionId,
      grimodexTurnId: active.grimodexTurnId,
      event: { type: "thread-started", threadId: active.codexThreadId },
    } satisfies CodexAppEventEnvelope);
    let requestAccepted = false;
    try {
      const result = await rpc.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: turnInput }],
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          sandbox: active.allowApprovals ? "workspace-write" : "read-only",
          approvalPolicy: active.allowApprovals ? "on-request" : "never",
          clientUserMessageId: input.clientUserMessageId,
        },
        { retry: false },
      );
      requestAccepted = true;
      const codexTurnId = extractTurnId(result) ?? active.codexTurnId;
      if (!codexTurnId) {
        throw new CodexAppServerError(
          "Codex App Server returned no turn id",
          "CODEX_APP_SERVER_PROTOCOL",
          false,
        );
      }
      active.codexTurnId = codexTurnId;
      await options.threadBindings.upsert({
        ...binding,
        lastTurnId: codexTurnId,
        updatedAt: nowIso(now),
      });
      return { codexThreadId: threadId, codexTurnId, reusedThread };
    } catch (cause) {
      activeTurns.delete(
        keyFor(input.projectId, input.sessionId, input.grimodexTurnId),
      );
      if (cause instanceof CodexAppServerError && !cause.preTurn) throw cause;
      const preTurn =
        !requestAccepted && !active.turnStarted && !active.outputStarted;
      throw new CodexAppServerError(
        cause instanceof Error ? cause.message : String(cause),
        preTurn
          ? CODEX_APP_SERVER_PRE_TURN_CODE
          : "CODEX_APP_SERVER_TURN_FAILED",
        preTurn,
      );
    }
  };

  const interruptTurn = async (
    input: InterruptCodexAppTurnPayload,
  ): Promise<void> => {
    const active = findActive(
      input.projectId,
      input.sessionId,
      input.grimodexTurnId,
    );
    if (!active?.codexTurnId) {
      throw new Error("Codex turn is not active or has no turn id");
    }
    const rpc = await ensureReady();
    await rpc.request(
      "turn/interrupt",
      { threadId: active.codexThreadId, turnId: active.codexTurnId },
      { retry: false },
    );
  };

  const respondToServerRequest = async (
    input: RespondCodexServerRequestPayload,
  ): Promise<void> => {
    const id = parseServerRequestId(input.requestId);
    const pending = pendingRequests.get(requestKey(id));
    if (!pending) throw new Error("Unknown Codex server request id");
    if (
      pending.projectId !== input.projectId ||
      pending.sessionId !== input.sessionId ||
      pending.grimodexTurnId !== input.grimodexTurnId
    ) {
      throw new Error("Codex server request authority mismatch");
    }
    pendingRequests.delete(requestKey(id));
    pending.resolve({ decision: input.decision });
  };

  const archiveSessionThread = async (
    projectId: string,
    sessionId: string,
  ): Promise<void> => {
    const binding = await options.threadBindings.get(
      projectId,
      sessionId,
      CODEX_APP_RUNTIME,
    );
    if (!binding) return;
    const rpc = await ensureReady();
    await rpc.request(
      "thread/archive",
      { threadId: binding.externalThreadId },
      { retry: true },
    );
    await options.threadBindings.delete(
      projectId,
      sessionId,
      CODEX_APP_RUNTIME,
    );
  };

  const setThreadName = async (
    input: SetCodexThreadNamePayload,
  ): Promise<void> => {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 256) {
      throw new Error("Codex thread name must be between 1 and 256 characters");
    }
    const binding = await options.threadBindings.get(
      input.projectId,
      input.sessionId,
      CODEX_APP_RUNTIME,
    );
    if (!binding) return;
    const rpc = await ensureReady();
    await rpc.request(
      "thread/name/set",
      { threadId: binding.externalThreadId, name },
      { retry: true },
    );
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    status = { ...status, state: "closing" };
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error("Codex App Server manager disposed"));
    }
    pendingRequests.clear();
    connection?.dispose();
    connection = null;
    await process?.dispose();
    process = null;
    activeTurns.clear();
    status = { ...status, state: "stopped" };
  };

  const handlers: ShellCommandHandlers = {
    codex_app_get_status: async () => getStatus(),
    codex_app_test_connection: async () => {
      await ensureReady();
      return getStatus();
    },
    codex_app_list_models: async () => listModels(),
    codex_app_start_turn: async (args) =>
      startTurn({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        grimodexTurnId: requiredString(args, "grimodexTurnId"),
        clientUserMessageId: requiredString(args, "clientUserMessageId"),
        model: optionalString(args, "model"),
        effort: optionalString(args, "effort"),
        contextPacket: packetString(args, "contextPacket"),
        bootstrapHistory: optionalPacketString(args, "bootstrapHistory"),
        historyRevision: requiredString(args, "historyRevision"),
        userMessage: packetString(args, "userMessage"),
      }),
    codex_app_interrupt_turn: async (args) => {
      await interruptTurn({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        grimodexTurnId: requiredString(args, "grimodexTurnId"),
      });
      return null;
    },
    codex_app_respond_to_request: async (args) => {
      const decision = args.decision;
      if (decision !== "accept" && decision !== "decline") {
        throw new Error("invalid args `decision`: expected accept or decline");
      }
      await respondToServerRequest({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        grimodexTurnId: requiredString(args, "grimodexTurnId"),
        requestId: parseServerRequestId(args.requestId),
        decision,
      });
      return null;
    },
    codex_app_archive_session_thread: async (args) => {
      await archiveSessionThread(
        requiredString(args, "projectId"),
        requiredString(args, "sessionId"),
      );
      return null;
    },
    codex_app_set_thread_name: async (args) => {
      await setThreadName({
        projectId: requiredString(args, "projectId"),
        sessionId: requiredString(args, "sessionId"),
        name: packetString(args, "name"),
      });
      return null;
    },
  };

  return {
    handlers,
    getStatus,
    listModels,
    startTurn,
    interruptTurn,
    respondToServerRequest,
    archiveSessionThread,
    setThreadName,
    dispose,
  };
}
