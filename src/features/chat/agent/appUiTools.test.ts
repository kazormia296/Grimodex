// @vitest-environment happy-dom
/**
 * UI 操作ツール（run_app_command／apply_layout_preset）の性質を固定する。
 * 拒否（未知・agent に出さない・blocked・今は使えない・policy off・no-host・phone・ロック）が
 * 副作用なしであること、実行後の「元に戻す」で表示が戻ること、manifest の権限、1 応答あたりの上限。
 */
import type { ToolResult } from "@/features/chat/agent/agentTypes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

const policy = vi.hoisted(() => ({ off: false, asked: [] as string[] }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: (feature: string) => {
    policy.asked.push(feature);
    return policy.off;
  },
  isAiFeatureBlockedByPolicy: () => policy.off,
}));

import {
  createUiOperationLimitHandler,
  withUiOperationLimit,
} from "@/application/chat/chatAgentToolHandlers";
import { listAgentRunnableCommandIds } from "@/features/commands/appCommandRegistry";
import {
  registerCommandContext,
  type CommandContext,
} from "@/features/commands/commandContext";
import {
  captureUiSnapshot,
  useUiUndoStore,
} from "@/features/commands/uiOperationUndo";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import { applyLayoutPresetTool, runAppCommandTool } from "./appUiTools";
import { AGENT_TOOLS } from "./toolDefinitions";
import {
  AGENT_TOOL_MANIFEST,
  HERMES_ALLOWED_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
} from "./toolManifest";
import {
  AGENT_RUNNABLE_COMMAND_IDS,
  APPLY_LAYOUT_PRESET_TOOL,
  MAX_UI_OPERATIONS_PER_TURN,
  RUN_APP_COMMAND_TOOL,
  UI_OPERATION_TOOL_NAMES,
} from "./uiOperationTools";

let settingsOpened = 0;
let exportToggled = 0;

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    phoneWorkspace: false,
    runtimeCapabilities: { genericProjectTransfer: true },
    onToggleExport: () => void (exportToggled += 1),
    onOpenSettings: () => void (settingsOpened += 1),
    ...overrides,
  };
}

let unregister: (() => void) | null = null;

function useHost(overrides: Partial<CommandContext> = {}) {
  unregister?.();
  unregister = registerCommandContext(context(overrides));
}

function resetLayout() {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ editorOpen: true }),
    layoutLocked: false,
    hiddenStripePanels: new Set(),
    activePresetId: "builtin:default",
    customPresets: [],
    initialized: true,
    openOverlay: null,
    maximizedPanelId: null,
  });
  // 左の overlay に Snippets を置く（slot と overlay の二重登録にならない正規の経路）。
  useLayoutStore.getState().movePanelToOverlay("snippets", "left");
  useLayoutStore.setState({ openOverlay: null });
}

beforeEach(() => {
  policy.off = false;
  policy.asked = [];
  settingsOpened = 0;
  exportToggled = 0;
  resetLayout();
  useCompactNavigationStore.getState().reset();
  useUiUndoStore.setState({ entries: {} });
  document.body.innerHTML = "";
  useHost();
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

function layoutOf() {
  const state = useLayoutStore.getState();
  return {
    layout: state.layout,
    activePresetId: state.activePresetId,
    openOverlay: state.openOverlay,
  };
}

function errorContent(result: { content: unknown }) {
  return result.content as { error: string; [key: string]: unknown };
}

describe("manifest と定義（Hermes・権限）", () => {
  const tools = AGENT_TOOL_MANIFEST.filter((tool) =>
    UI_OPERATION_TOOL_NAMES.includes(tool.name),
  );

  it("write・policy chat・agent と native だけ・確認なし。Hermes には出ない", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...UI_OPERATION_TOOL_NAMES].sort(),
    );
    for (const tool of tools) {
      expect(tool).toMatchObject({
        capability: "write",
        requiredPolicy: "chat",
        requiresUserConfirmation: false,
      });
      expect([...tool.allowedChannels]).toEqual(["agent", "native"]);
      expect(tool.allowedChannels).not.toContain("hermes");
      expect(MUTATING_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(HERMES_ALLOWED_TOOL_NAMES).not.toContain(tool.name);
    }
  });

  it("Hermes の本文 channel から実行できる名前に含まれない（read だけを通す）", () => {
    for (const name of UI_OPERATION_TOOL_NAMES) {
      expect(HERMES_ALLOWED_TOOL_NAMES.includes(name)).toBe(false);
    }
  });

  it("run_app_command の enum は registry の agent かつ view と一致し、export などを含まない", () => {
    const tool = AGENT_TOOLS.find((t) => t.name === RUN_APP_COMMAND_TOOL);
    expect(tool?.inputSchema.properties.command?.enum).toEqual(
      listAgentRunnableCommandIds(),
    );
    expect([...AGENT_RUNNABLE_COMMAND_IDS]).toEqual(
      listAgentRunnableCommandIds(),
    );
    for (const id of [
      "toggleExport",
      "nextTab",
      "splitVertical",
      "focusChat",
      "focusChatHistory",
      "focusTrashBin",
    ]) {
      expect(AGENT_RUNNABLE_COMMAND_IDS).not.toContain(id);
    }
    expect(
      AGENT_TOOLS.find((t) => t.name === APPLY_LAYOUT_PRESET_TOOL)?.inputSchema
        .required,
    ).toEqual(["preset"]);
  });
});

describe("run_app_command の拒否は副作用なし", () => {
  it("未知の id は error と許可一覧を返す", async () => {
    const before = layoutOf();
    const result = await runAppCommandTool({ command: "noSuchCommand" });
    expect(result.error).toContain("Unknown command");
    expect(errorContent(result).allowedCommands).toEqual(
      listAgentRunnableCommandIds(),
    );
    expect(layoutOf()).toEqual(before);
    expect(result.undoId).toBeUndefined();
  });

  it("入力が無い・長すぎる・文字列でない id も error", async () => {
    for (const params of [
      {},
      { command: 42 },
      { command: "x".repeat(500) },
      { command: "" },
    ]) {
      const result = await runAppCommandTool(params);
      expect(result.error).toBeTruthy();
    }
  });

  it("agent に出さないコマンド（tab 切替・Chat と Chat History・ゴミ箱）は実行しない", async () => {
    // ゴミ箱は mount 時に期限切れの項目を DB から永久削除するので、開くだけでも出さない。
    const before = layoutOf();
    for (const command of [
      "nextTab",
      "splitVertical",
      "focusChat",
      "focusChatHistory",
      "focusTrashBin",
    ]) {
      const result = await runAppCommandTool({ command });
      expect(result.error, command).toContain("not allowed");
    }
    expect(layoutOf()).toEqual(before);
  });

  it("blocked の export は、host の文脈で使える状態でも実行しない", async () => {
    const result = await runAppCommandTool({ command: "toggleExport" });
    expect(result.error).toContain("not allowed");
    expect(exportToggled).toBe(0);
  });

  it("今は使えない状態（空の overlay・phone 幅）は error で、何も変えない", async () => {
    const before = layoutOf();
    const empty = await runAppCommandTool({ command: "toggleRightOverlay" });
    expect(empty.error).toContain("not available now");
    useHost({ phoneWorkspace: true });
    const phone = await runAppCommandTool({ command: "toggleLeftOverlay" });
    expect(phone.error).toContain("not available now");
    expect(layoutOf()).toEqual(before);
  });

  it("host が無い（no-host）なら error", async () => {
    unregister?.();
    unregister = null;
    const before = layoutOf();
    const result = await runAppCommandTool({ command: "focusScenes" });
    expect(result.error).toContain("No command host");
    expect(layoutOf()).toEqual(before);
  });

  it("複数 host で後の host が外れて登録が空になった場合も no-host の error", async () => {
    const second = registerCommandContext(context());
    second(); // 後勝ちの枠が空になる（先の host が残っていても）
    const result = await runAppCommandTool({ command: "focusScenes" });
    expect(result.error).toContain("No command host");
  });

  it("パネルの別ウィンドウ（host は mount される）では、その窓の layout を変えず error", async () => {
    const before = layoutOf();
    window.history.replaceState({}, "", "/?window=panel&panel=codex");
    try {
      const result = await runAppCommandTool({ command: "focusScenes" });
      expect(result.error).toContain("detached panel window");
      expect(result.undoId).toBeUndefined();
    } finally {
      window.history.replaceState({}, "", "/");
    }
    expect(layoutOf()).toEqual(before);
  });

  it("AI ポリシーで chat が off なら、実行の前に拒否する", async () => {
    policy.off = true;
    const before = layoutOf();
    const result = await runAppCommandTool({ command: "focusScenes" });
    expect(result.error).toContain("policy");
    expect(policy.asked).toContain("chat");
    expect(layoutOf()).toEqual(before);
    expect(settingsOpened).toBe(0);
    const open = await runAppCommandTool({ command: "openSettings" });
    expect(open.error).toContain("policy");
    expect(settingsOpened).toBe(0);
  });
});

describe("run_app_command の実行と元に戻す", () => {
  it("overlay を開くと undoId と実行後の UI 状態を返し、元に戻すで閉じる", async () => {
    const result = await runAppCommandTool({ command: "toggleLeftOverlay" });
    expect(result.error).toBeUndefined();
    expect(useLayoutStore.getState().openOverlay).toBe("left");
    const content = result.content as {
      ok: boolean;
      undoable: boolean;
      ui: { openOverlay: string | null };
    };
    expect(content.ok).toBe(true);
    expect(content.undoable).toBe(true);
    expect(content.ui.openOverlay).toBe("left");
    expect(result.undoId).toBeTruthy();

    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().openOverlay).toBeNull();
    // 1 回だけ。2 回目は何もしない。
    useLayoutStore.setState({ openOverlay: "left" });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("unavailable");
    expect(useLayoutStore.getState().openOverlay).toBe("left");
  });

  it("パネルの表示を切り替え、元に戻すと layout が操作の前の状態に戻る", async () => {
    const before = layoutOf();
    const wasActive = useLayoutStore.getState().isPanelActive("scenes");
    const result = await runAppCommandTool({ command: "focusScenes" });
    expect(result.error).toBeUndefined();
    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(!wasActive);
    expect(result.undoId).toBeTruthy();

    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(wasActive);
    expect(JSON.stringify(useLayoutStore.getState().layout)).toBe(
      JSON.stringify(before.layout),
    );
  });

  it("設定画面を開くのは layout を変えないので undoId を出さない（元に戻せるとは言わない）", async () => {
    const result = await runAppCommandTool({ command: "openSettings" });
    expect(result.error).toBeUndefined();
    expect(settingsOpened).toBe(1);
    expect(result.undoId).toBeUndefined();
    expect((result.content as { undoable: boolean }).undoable).toBe(false);
  });

  it("phone 幅の画面切替も戻せる", async () => {
    useHost({ phoneWorkspace: true });
    const result = await runAppCommandTool({ command: "focusCodex" });
    expect(result.error).toBeUndefined();
    expect(useCompactNavigationStore.getState().activeSurface).toBe("codex");
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    expect(useCompactNavigationStore.getState().backStack).toEqual([]);
  });

  it("後の操作があるときは、先の操作を戻さない（後の変更を巻き戻さない）。後の操作から順に戻せる", async () => {
    const first = await runAppCommandTool({ command: "toggleLeftOverlay" });
    const second = await runAppCommandTool({ command: "focusScenes" });
    expect(first.undoId && second.undoId).toBeTruthy();
    const afterSecond = layoutOf();
    expect(useUiUndoStore.getState().undo(first.undoId!)).toBe("failed");
    expect(useUiUndoStore.getState().entries[first.undoId!]?.failure).toBe(
      "changed",
    );
    expect(layoutOf()).toEqual(afterSecond);
    expect(useUiUndoStore.getState().entries[first.undoId!]?.status).toBe(
      "available",
    );

    expect(useUiUndoStore.getState().undo(second.undoId!)).toBe("restored");
    expect(useUiUndoStore.getState().undo(first.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().openOverlay).toBeNull();
  });
});

describe("元に戻すの前提（画面の幅・操作の後の変更）", () => {
  it("操作の後に利用者が配置を変えたら戻さず failed（理由 changed）で、配置は今のまま", async () => {
    const result = await runAppCommandTool({ command: "focusScenes" });
    // 利用者が後で別のパネルを手で切り替えた。
    useLayoutStore.getState().togglePanel("codex");
    const now = layoutOf();
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(layoutOf()).toEqual(now);
    expect(useUiUndoStore.getState().entries[result.undoId!]).toMatchObject({
      status: "available",
      failure: "changed",
    });
  });

  it("操作の後に overlay を開閉した・最大化した場合も、戻さない", async () => {
    const result = await runAppCommandTool({ command: "focusScenes" });
    useLayoutStore.setState({ openOverlay: "left" });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(useLayoutStore.getState().openOverlay).toBe("left");
    useLayoutStore.setState({ openOverlay: null, maximizedPanelId: "editor" });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");
  });

  it("overlay を開く操作は、ボタンの pointerdown で overlay が閉じていても戻せる（操作前と同じ向きの変化）", async () => {
    const result = await runAppCommandTool({ command: "toggleLeftOverlay" });
    expect(useLayoutStore.getState().openOverlay).toBe("left");
    // useOverlayDismiss が、overlay の外の pointerdown で closeOverlay() を呼ぶ。
    useLayoutStore.setState({ openOverlay: null });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().openOverlay).toBeNull();
    expect(useUiUndoStore.getState().entries[result.undoId!]?.status).toBe(
      "undone",
    );
  });

  it("最大化が操作前の状態に戻っていても戻せる。別のパネルへ変わっていれば戻さない", () => {
    useLayoutStore.setState({ maximizedPanelId: "editor" });
    const before = captureUiSnapshot();
    useLayoutStore.setState({ maximizedPanelId: null, openOverlay: "left" });
    const id = useUiUndoStore.getState().register(before, captureUiSnapshot());
    useLayoutStore.setState({ maximizedPanelId: "editor", openOverlay: null });
    expect(useUiUndoStore.getState().undo(id)).toBe("restored");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("editor");

    const id2 = useUiUndoStore.getState().register(before, captureUiSnapshot());
    useLayoutStore.setState({ maximizedPanelId: "scenes" });
    expect(useUiUndoStore.getState().undo(id2)).toBe("failed");
    expect(useLayoutStore.getState().maximizedPanelId).toBe("scenes");
  });

  it("phone 幅で、パネルの command の後に「元に戻す」のある ai の画面へ戻っていても戻せる", async () => {
    useHost({ phoneWorkspace: true });
    useCompactNavigationStore.getState().openSurface("ai");
    const result = await runAppCommandTool({ command: "focusCodex" });
    expect(useCompactNavigationStore.getState().activeSurface).toBe("codex");
    // ボタンは ai の画面にしか出ないので、押す前に利用者が ai へ戻る。
    useCompactNavigationStore.getState().openSurface("ai");
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("ai");
  });

  it("利用者が別の overlay へ変えた間は戻さず、操作の直後の状態に戻せば戻せる", async () => {
    const result = await runAppCommandTool({ command: "toggleLeftOverlay" });
    useLayoutStore.setState({ openOverlay: "right" });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    useLayoutStore.setState({ openOverlay: "left" });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().openOverlay).toBeNull();
  });

  it("apply_layout_preset の後に配置が変わっても同じ（戻さない）", async () => {
    const result = await applyLayoutPresetTool({ preset: "builtin:plan" });
    expect(result.undoId).toBeTruthy();
    useLayoutStore.getState().togglePanel("scenes");
    const now = layoutOf();
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(layoutOf()).toEqual(now);
  });

  it("画面の幅の profile（phone か否か）が登録のときと違えば、戻さず failed（理由 viewport）", async () => {
    const result = await runAppCommandTool({ command: "focusScenes" });
    const now = layoutOf();
    useHost({ phoneWorkspace: true });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(layoutOf()).toEqual(now);
    expect(useUiUndoStore.getState().entries[result.undoId!]).toMatchObject({
      status: "available",
      failure: "viewport",
    });
    // 幅が元に戻れば、戻せる。
    useHost({ phoneWorkspace: false });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
  });

  it("phone 幅で登録した退避を desktop 幅で戻そうとしても戻さない", async () => {
    useHost({ phoneWorkspace: true });
    const result = await runAppCommandTool({ command: "focusCodex" });
    useHost({ phoneWorkspace: false });
    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("failed");
    expect(useCompactNavigationStore.getState().activeSurface).toBe("codex");
  });
});

describe("apply_layout_preset", () => {
  it("組み込みのプリセットを適用し、元に戻すで配置とプリセットが戻る", async () => {
    const before = layoutOf();
    const result = await applyLayoutPresetTool({ preset: "builtin:review" });
    expect(result.error).toBeUndefined();
    expect(useLayoutStore.getState().activePresetId).toBe("builtin:review");
    expect(result.undoId).toBeTruthy();
    const content = result.content as {
      preset: { id: string; builtin: boolean };
      ui: { layoutPreset: { id: string } | null };
    };
    expect(content.preset.id).toBe("builtin:review");
    expect(content.ui.layoutPreset?.id).toBe("builtin:review");

    expect(useUiUndoStore.getState().undo(result.undoId!)).toBe("restored");
    expect(useLayoutStore.getState().activePresetId).toBe(
      before.activePresetId,
    );
    expect(JSON.stringify(useLayoutStore.getState().layout)).toBe(
      JSON.stringify(before.layout),
    );
  });

  it("利用者の保存したプリセットも id で適用できる", async () => {
    const custom = {
      id: "custom:mine",
      name: "私の配置",
      state: buildDefaultLayoutState({ editorOpen: true }),
    };
    useLayoutStore.setState({
      customPresets: [custom as never],
    });
    const result = await applyLayoutPresetTool({ preset: "custom:mine" });
    expect(result.error).toBeUndefined();
    expect(useLayoutStore.getState().activePresetId).toBe("custom:mine");
  });

  it("未知の id・空は、副作用なしで error と選べるプリセットの一覧を返す", async () => {
    const before = layoutOf();
    for (const params of [
      { preset: "builtin:nope" },
      { preset: "" },
      {},
      { preset: 7 },
      { preset: "x".repeat(500) },
    ]) {
      const result = await applyLayoutPresetTool(params);
      expect(result.error).toBeTruthy();
      const listed = errorContent(result).availablePresets as Array<{
        id: string;
      }>;
      expect(listed.map((preset) => preset.id)).toContain("builtin:plan");
    }
    expect(layoutOf()).toEqual(before);
  });

  it("policy off・host なし・phone 幅・ロック中・別ウィンドウは拒否して何も変えない", async () => {
    const before = layoutOf();

    policy.off = true;
    expect(
      (await applyLayoutPresetTool({ preset: "builtin:plan" })).error,
    ).toContain("policy");
    policy.off = false;

    unregister?.();
    unregister = null;
    expect(
      (await applyLayoutPresetTool({ preset: "builtin:plan" })).error,
    ).toContain("No command host");

    useHost({ phoneWorkspace: true });
    expect(
      (await applyLayoutPresetTool({ preset: "builtin:plan" })).error,
    ).toContain("phone");

    useHost();
    useLayoutStore.setState({ layoutLocked: true });
    expect(
      (await applyLayoutPresetTool({ preset: "builtin:plan" })).error,
    ).toContain("locked");
    useLayoutStore.setState({ layoutLocked: false });

    window.history.replaceState({}, "", "/?window=panel&panel=codex");
    try {
      expect(
        (await applyLayoutPresetTool({ preset: "builtin:plan" })).error,
      ).toContain("detached panel window");
    } finally {
      window.history.replaceState({}, "", "/");
    }

    expect(layoutOf()).toEqual(before);
  });

  it("適用が成立しなかった（layoutReplaceSeq が進まない）場合は ok と言わず error", async () => {
    const applyPreset = useLayoutStore.getState().applyPreset;
    useLayoutStore.setState({ applyPreset: () => {} });
    try {
      const result = await applyLayoutPresetTool({ preset: "builtin:plan" });
      expect(result.error).toContain("not applied");
      expect(result.undoId).toBeUndefined();
    } finally {
      useLayoutStore.setState({ applyPreset });
    }
  });
});

describe("1 応答あたりの UI 操作の上限", () => {
  it("上限（既定 10）までは通し、超えた呼び出しは実行せず error。他のツールは数えない", () => {
    expect(MAX_UI_OPERATIONS_PER_TURN).toBe(10);
    const limit = createUiOperationLimitHandler();
    for (let i = 0; i < MAX_UI_OPERATIONS_PER_TURN; i += 1) {
      const name =
        i % 2 === 0 ? RUN_APP_COMMAND_TOOL : APPLY_LAYOUT_PRESET_TOOL;
      expect(limit(name, `c${i}`)).toBeNull();
      expect(limit("get_scene", `r${i}`)).toBeNull();
    }
    const over = limit(RUN_APP_COMMAND_TOOL, "c-over");
    expect(over?.error).toContain("limit reached");
    expect(over?.toolCallId).toBe("c-over");
    expect(limit(APPLY_LAYOUT_PRESET_TOOL, "c-over2")?.error).toBeTruthy();
    expect(limit("get_scene", "still-ok")).toBeNull();
  });

  it("失敗した呼び出しも 1 回に数え、応答（ターン）ごとに独立する", () => {
    const limit = createUiOperationLimitHandler(2);
    expect(limit(RUN_APP_COMMAND_TOOL, "a")).toBeNull();
    expect(limit(RUN_APP_COMMAND_TOOL, "b")).toBeNull();
    expect(limit(RUN_APP_COMMAND_TOOL, "c")?.error).toBeTruthy();
    // 次の応答（「続行」を含む新しいターン）は新しい枠。
    expect(
      createUiOperationLimitHandler(2)(RUN_APP_COMMAND_TOOL, "d"),
    ).toBeNull();
  });
});

describe("withUiOperationLimit（送信ターンの executeTool を包む）", () => {
  it("上限を超えた UI 操作は包んだ executeTool を呼ばず error を返し、他のツールは素通しする", async () => {
    const execute = vi.fn(
      async (name: string, toolCallId: string): Promise<ToolResult> => ({
        toolCallId,
        name,
        content: { ok: true },
        summary: "ok",
        tokensUsed: 1,
      }),
    );
    const guarded = withUiOperationLimit(execute);
    for (let i = 0; i < MAX_UI_OPERATIONS_PER_TURN; i += 1) {
      expect(
        (await guarded(RUN_APP_COMMAND_TOOL, `c${i}`)).error,
      ).toBeUndefined();
    }
    const over = await guarded(APPLY_LAYOUT_PRESET_TOOL, "over");
    expect(over.error).toContain("limit reached");
    expect(execute).toHaveBeenCalledTimes(MAX_UI_OPERATIONS_PER_TURN);
    expect((await guarded("get_scene", "r")).error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(MAX_UI_OPERATIONS_PER_TURN + 1);
    // 包み直す（次のターン）と新しい枠になる。
    expect(
      (await withUiOperationLimit(execute)(RUN_APP_COMMAND_TOOL, "next")).error,
    ).toBeUndefined();
  });
});

describe("元に戻せない場合（本文の保護・復元の棄却）", () => {
  it("inline AI の未確定の結果があるときは戻さず、退避は残る（本文を守る）", async () => {
    const result = await runAppCommandTool({ command: "toggleLeftOverlay" });
    const layoutBefore = useLayoutStore.getState().layout;
    // 配置の差し替えを伴う戻し（focusScenes）で確かめる。
    const panel = await runAppCommandTool({ command: "focusScenes" });
    useInlineAiStore.setState({ status: "diffShown" });
    try {
      expect(useUiUndoStore.getState().undo(panel.undoId!)).toBe("blocked");
      expect(useUiUndoStore.getState().entries[panel.undoId!]?.status).toBe(
        "available",
      );
    } finally {
      useInlineAiStore.setState({ status: "idle" });
    }
    expect(useLayoutStore.getState().layout).not.toBe(layoutBefore);
    expect(result.undoId).toBeTruthy();
  });

  it("写しの配置を今の画面で復元できないときは failed を返し、戻したことにしない", () => {
    const before = captureUiSnapshot();
    // Snippets が slot と overlay の両方にある（validate が棄却する）配置を写しに入れる。
    const invalid = buildDefaultLayoutState({ editorOpen: true });
    invalid.overlays = { left: { panel: "snippets" }, right: { panel: null } };
    const broken = {
      ...before,
      layout: invalid,
      activePresetId: "builtin:plan",
    };
    const id = useUiUndoStore.getState().register(broken, captureUiSnapshot());
    const current = useLayoutStore.getState().layout;
    const seq = useLayoutStore.getState().layoutReplaceSeq;
    expect(useUiUndoStore.getState().undo(id)).toBe("failed");
    expect(useLayoutStore.getState().layout).toBe(current);
    // 棄却したときは、preset id なども含めて何も変わらない。
    expect(useLayoutStore.getState().activePresetId).toBe("builtin:default");
    expect(useLayoutStore.getState().layoutReplaceSeq).toBe(seq);
    expect(useUiUndoStore.getState().entries[id]?.status).toBe("available");
  });
});
