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
import { randomUUID } from "node:crypto";

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
    cmd === "agent_snippet_create"
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
  const boundPayload = bindCanonicalAuthorityContext(payload, route);
  if (typeof senderId === "number" && Number.isInteger(senderId)) {
    const authoritySession =
      rendererAuthoritySessions.get(senderId) ?? randomUUID();
    rendererAuthoritySessions.set(senderId, authoritySession);
    boundPayload.sessionId = authoritySession;
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
