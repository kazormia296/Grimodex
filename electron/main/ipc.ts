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
  "agent_codex_create",
  "agent_codex_update",
  "agent_codex_delete",
  "agent_codex_mutate",
  "snippet_create",
  "snippet_update",
  "snippet_delete",
  "entity_tags_set",
  "project_create",
  "project_patch",
  "temporal_scene_patch",
]);

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
    cmd === "agent_foreshadow_create" ||
    cmd === "agent_foreshadow_update" ||
    cmd === "agent_snippet_create"
  ) {
    return "interactive-agent-command";
  }

  if (
    cmd === "foreshadow_create" ||
    cmd === "foreshadow_update" ||
    cmd === "foreshadow_delete"
  ) {
    return payload.origin === "human" ? "human-direct" : undefined;
  }

  if (GENERIC_CANONICAL_WRITER_COMMANDS.has(cmd)) {
    switch (payload.origin) {
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
      return "import-apply";
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
): CommandArgs {
  const payloadKey = cmd === "foreshadow_update" ? "patch" : "payload";
  const payload = args[payloadKey];
  if (!isRecord(payload)) return args;
  const route = authorityRouteForRendererCommand(cmd, payload);
  if (!route) return args;
  return {
    ...args,
    [payloadKey]: bindCanonicalAuthorityContext(payload, route),
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
          bindRendererAuthorityForIpc(cmd, rawArgs),
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
