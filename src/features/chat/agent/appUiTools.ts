/**
 * アプリの UI を操作する agent ツール 2 本（設計書 §5・§6 の view の段）。
 *
 *  - run_app_command:   registry の `agent: true` かつ `risk: "view"` のコマンドだけ実行する
 *  - apply_layout_preset: 組み込みと利用者の既存プリセットだけ適用する
 *
 * 信頼境界（設計書 §7）: 本文・Codex・Web 検索の結果・取り込んだファイルに仕込まれた指示で
 * agent が誘導されうる。だから実行できる範囲を、データを変えず画面の表示だけで layout の退避で
 * 戻せるものに絞り、確認は求めない代わりに「元に戻す」を chat の tool 結果に出す（undoId）。
 * 未知の id・agent に出さないもの・blocked・今は使えない状態・host なし・パネルの別ウィンドウ（と、プリセットでは phone 幅・ロック中）は、
 * 副作用なしで error を返す。AI ポリシーで chat が off なら、実行の前に拒否する。
 * export・ファイル書出し・外部送信・AI 設定の変更は registry でも agent に出していない。
 *
 * host（GlobalCommandHost）が commandContext に登録する文脈は後勝ちの 1 枠で、host は 1 つだけの前提。
 * 空（または複数 host で外れた）ときは `no-host` の error にする（commandContext.ts の注記を参照）。
 */
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import {
  getAppCommand,
  isAgentRunnable,
  listAgentRunnableCommandIds,
  runAppCommand,
} from "@/features/commands/appCommandRegistry";
import { getRegisteredCommandContext } from "@/features/commands/commandContext";
import {
  captureUiSnapshot,
  uiSnapshotsDiffer,
  useUiUndoStore,
} from "@/features/commands/uiOperationUndo";
import {
  getBuiltinPresets,
  isBuiltinPresetId,
} from "@/features/layout/layoutPresets";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { isPanelWindow } from "@/features/layout/multiwindow/panelWindow";
import { readUiState } from "@/help/uiState";
import type { ToolResult } from "./agentTypes";
import { countTokens } from "../contextBuilder";
import {
  APPLY_LAYOUT_PRESET_TOOL,
  RUN_APP_COMMAND_TOOL,
} from "./uiOperationTools";

type ToolReturn = Omit<ToolResult, "toolCallId">;

/** id の長さの上限（超えたら error）。 */
const MAX_ID_LENGTH = 200;
/** error の summary に未知の入力を写すときの上限。 */
const ECHO_LENGTH = 60;
/** rAF が来ない（背面の window 等）ときに結果を待つ上限。 */
const SETTLE_TIMEOUT_MS = 50;

function clip(text: string): string {
  return text.length > ECHO_LENGTH ? `${text.slice(0, ECHO_LENGTH)}…` : text;
}

function fail(name: string, message: string, content: unknown): ToolReturn {
  return {
    name,
    content,
    summary: message,
    tokensUsed: countTokens(JSON.stringify(content)),
    error: message,
  };
}

function succeed(
  name: string,
  content: unknown,
  summary: string,
  undoId?: string,
): ToolReturn {
  return {
    name,
    content,
    summary,
    tokensUsed: countTokens(JSON.stringify(content)),
    ...(undoId ? { undoId } : {}),
  };
}

/**
 * コマンドの中には、次の描画フレームで表示を確定するもの（Scene Context パネル等）がある。
 * 結果の UI 状態がずれないよう、1 フレームだけ待つ（来なくても上限で進む）。
 */
function settleFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

function policyOff(name: string): ToolReturn {
  return fail(name, "AI policy has chat turned off", {
    error:
      "This project's AI policy turns chat off, so UI operations are refused.",
  });
}

export async function runAppCommandTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const name = RUN_APP_COMMAND_TOOL;
  if (blockIfPolicyOff("chat")) return policyOff(name);

  const raw = params["command"];
  const id = typeof raw === "string" ? raw.trim() : "";
  const allowed = listAgentRunnableCommandIds();
  if (id.length > MAX_ID_LENGTH) {
    return fail(name, "command is too long", {
      error: `command is too long (max ${MAX_ID_LENGTH} characters).`,
      allowedCommands: allowed,
    });
  }
  const command = id ? getAppCommand(id) : undefined;
  if (!command) {
    return fail(name, `Unknown command: ${id ? clip(id) : "(empty)"}`, {
      error:
        "Unknown command. Use one of allowedCommands exactly (ids come from get_app_help_index).",
      allowedCommands: allowed,
    });
  }
  if (!isAgentRunnable(command)) {
    return fail(name, `Command not allowed for the assistant: ${command.id}`, {
      error:
        "This command cannot be run by the assistant. Tell the user how to do it themselves (get_app_help) instead.",
      allowedCommands: allowed,
    });
  }
  const ctx = getRegisteredCommandContext();
  if (!ctx) {
    return fail(name, "No command host is available", {
      error:
        "The app's command host is not available right now (no-host). Nothing was changed.",
    });
  }

  if (isPanelWindow()) {
    // 別ウィンドウでも host は mount される。そこの layout store を変えると、主画面の配置の保存を上書きしうる。
    return fail(name, "Commands are not available in a detached panel window", {
      error:
        "This is a detached panel window, not the main window. Nothing was changed.",
    });
  }

  const before = captureUiSnapshot();
  const result = runAppCommand(command.id, ctx);
  if (!result.ok) {
    return fail(
      name,
      `Command not available now: ${command.id} (${result.reason})`,
      {
        error: `The command cannot run in the current state (${result.reason}), e.g. a narrow-width (phone) screen or an empty overlay. Nothing was changed.`,
      },
    );
  }
  await settleFrame();
  const after = captureUiSnapshot();
  const changed = uiSnapshotsDiffer(before, after);
  const undoId = changed
    ? useUiUndoStore.getState().register(before, after)
    : undefined;
  return succeed(
    name,
    {
      ok: true,
      command: command.id,
      layoutChanged: changed,
      undoable: undoId !== undefined,
      ...(undoId === undefined
        ? {
            note: "The layout did not change, or this command's effect (e.g. opening Settings) is not covered by Undo; the user can close or revert it themselves.",
          }
        : {}),
      ui: readUiState(),
    },
    `Ran command ${command.id}${undoId ? " (undo available)" : ""}`,
    undoId,
  );
}

function listPresets(): Array<{ id: string; name: string; builtin: boolean }> {
  const layout = useLayoutStore.getState();
  return [
    ...getBuiltinPresets(undefined, layout.builtinPresetOverrides).map(
      (preset) => ({ id: preset.id, name: preset.name, builtin: true }),
    ),
    ...layout.customPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      builtin: false,
    })),
  ];
}

export async function applyLayoutPresetTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  const name = APPLY_LAYOUT_PRESET_TOOL;
  if (blockIfPolicyOff("chat")) return policyOff(name);

  const raw = params["preset"];
  const id = typeof raw === "string" ? raw.trim() : "";
  if (id.length > MAX_ID_LENGTH) {
    return fail(name, "preset is too long", {
      error: `preset is too long (max ${MAX_ID_LENGTH} characters).`,
      availablePresets: listPresets(),
    });
  }
  const layout = useLayoutStore.getState();
  const known =
    id !== "" &&
    (isBuiltinPresetId(id) ||
      layout.customPresets.some((preset) => preset.id === id));
  if (!known) {
    return fail(name, `Unknown preset: ${id ? clip(id) : "(empty)"}`, {
      error:
        "Unknown preset. Use one id of availablePresets exactly (built-in or the user's saved presets).",
      availablePresets: listPresets(),
    });
  }
  const ctx = getRegisteredCommandContext();
  if (!ctx) {
    return fail(name, "No command host is available", {
      error:
        "The app's command host is not available right now (no-host). Nothing was changed.",
    });
  }
  if (ctx.phoneWorkspace) {
    return fail(
      name,
      "Layout presets are not available on a narrow (phone) screen",
      {
        error:
          "On a narrow-width (phone) screen the desktop layout is not shown and is not changed. Nothing was changed.",
      },
    );
  }
  if (isPanelWindow()) {
    return fail(
      name,
      "Layout presets are not available in a detached panel window",
      {
        error:
          "This is a detached panel window, not the main window. Nothing was changed.",
      },
    );
  }
  if (layout.layoutLocked) {
    return fail(name, "The layout is locked by the user", {
      error:
        "The user locked the layout, so it is not rearranged. Ask the user to unlock it, or tell them how to apply the preset themselves.",
    });
  }

  const before = captureUiSnapshot();
  const seqBefore = layout.layoutReplaceSeq;
  layout.applyPreset(id);
  if (useLayoutStore.getState().layoutReplaceSeq === seqBefore) {
    return fail(name, `Preset was not applied: ${clip(id)}`, {
      error:
        "The preset was not applied (for example, unsaved inline AI edits are pending in the editor). Nothing was changed.",
    });
  }
  const after = captureUiSnapshot();
  const changed = uiSnapshotsDiffer(before, after);
  const undoId = changed
    ? useUiUndoStore.getState().register(before, after)
    : undefined;
  const preset = listPresets().find((candidate) => candidate.id === id);
  return succeed(
    name,
    {
      ok: true,
      preset: preset ?? { id, name: null, builtin: isBuiltinPresetId(id) },
      layoutChanged: changed,
      undoable: undoId !== undefined,
      ui: readUiState(),
    },
    `Applied layout preset ${id}${undoId ? " (undo available)" : ""}`,
    undoId,
  );
}
