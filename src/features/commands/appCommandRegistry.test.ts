// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import {
  DEFAULT_KEYBINDINGS,
  PANEL_COMMANDS,
  getCommands,
} from "@/features/settings/keybindings";
import {
  getAppCommand,
  isAgentRunnable,
  isAppCommandAvailable,
  listAgentRunnableCommandIds,
  listAppCommands,
  matchesFixedKey,
  runAppCommand,
  runRegisteredAppCommand,
} from "./appCommandRegistry";
import {
  registerCommandContext,
  resolveCommandContext,
  type CommandContext,
} from "./commandContext";

/** エディタやツリーの中でだけ効く（registry の対象外）キー。 */
const PANE_SCOPED_IDS = ["find", "findReplace", "save", "inlineAiPalette"];

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    phoneWorkspace: false,
    runtimeCapabilities: { genericProjectTransfer: false },
    onToggleExport: () => {},
    onOpenSettings: () => {},
    ...overrides,
  };
}

describe("コマンド registry の定義", () => {
  it("getCommands() の id は、registry にあるか、pane 内だけのキーとして除外されている", () => {
    for (const command of getCommands()) {
      const inRegistry = getAppCommand(command.id) !== undefined;
      const paneScoped = PANE_SCOPED_IDS.includes(command.id);
      expect(
        inRegistry !== paneScoped,
        `${command.id} は registry か pane 内の除外リストのどちらか一方にある`,
      ).toBe(true);
    }
  });

  it("registry のパネルのコマンドは PANEL_COMMANDS と同じ id・panel で、同じ順に並ぶ", () => {
    const panels = listAppCommands()
      .filter((command) => command.panel !== undefined)
      .map(({ id, panel }) => ({ id, panel }));
    expect(panels).toEqual(PANEL_COMMANDS);
  });

  it("id は重複しない", () => {
    const ids = listAppCommands().map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("固定キーのコマンドは getCommands()／既定のキー割当に出ない（再割当できない）", () => {
    const fixed = listAppCommands().filter((command) => command.fixedKey);
    expect(fixed.map((command) => command.id).sort()).toEqual([
      "searchWorkspace",
      "toggleExport",
    ]);
    for (const command of fixed) {
      expect(getCommands().some((c) => c.id === command.id)).toBe(false);
      expect(DEFAULT_KEYBINDINGS[command.id]).toBeUndefined();
    }
  });

  it("agent に出すコマンドは、画面の表示だけで layout の退避で戻せる view の一覧に固定されている", () => {
    // 増やすときは、利用者のデータを変えないこと・元に戻せること・prompt injection で誘導されて
    // 困らないことを確かめたうえで、この表と toolDefinitions の enum（AGENT_RUNNABLE_COMMAND_IDS）を揃える。
    expect(listAgentRunnableCommandIds()).toEqual([
      "toggleLeftOverlay",
      "toggleRightOverlay",
      "searchWorkspace",
      "focusScenes",
      "focusCodex",
      "focusSnippets",
      "focusAttribution",
      "focusCodexQuick",
      "focusTimeline",
      "focusChronicle",
      "focusMap",
      "focusKouetsu",
      "focusForeshadow",
      "focusGrid",
      "focusMatrix",
      "focusWritingStats",
      "openSettings",
    ]);
  });

  it("agent: true は risk が view のものだけ。実行してよいかは agent と view の両方で決まる", () => {
    for (const command of listAppCommands()) {
      if (command.agent) expect(command.risk).toBe("view");
    }
    // agent フラグだけ立っていても、view でなければ実行してよい対象にならない。
    expect(
      isAgentRunnable({ ...getAppCommand("openSettings")!, risk: "blocked" }),
    ).toBe(false);
    expect(
      isAgentRunnable({ ...getAppCommand("openSettings")!, agent: false }),
    ).toBe(false);
  });

  it("agent に出さないもの: export（blocked）、tab の分割・切替（戻せない）、Chat と Chat History（今動いているパネル）、ゴミ箱（開くと期限切れの項目を永久削除する）", () => {
    for (const id of [
      "toggleExport",
      "splitVertical",
      "splitHorizontal",
      "nextTab",
      "prevTab",
      "focusChat",
      "focusChatHistory",
      "focusTrashBin",
    ]) {
      expect(isAgentRunnable(getAppCommand(id)!), id).toBe(false);
    }
  });

  it("export は agent に出せない段（blocked）にしている", () => {
    expect(getAppCommand("toggleExport")?.risk).toBe("blocked");
  });
});

describe("runAppCommand", () => {
  beforeEach(() => {
    const layout = buildDefaultLayoutState({ allInactive: true });
    layout.overlays = { left: { panel: "snippets" }, right: { panel: null } };
    useLayoutStore.setState({
      layout,
      openOverlay: null,
      maximizedPanelId: null,
    });
  });

  it("存在しない id は副作用なしで unknown-command", () => {
    expect(runAppCommand("noSuchCommand", context())).toEqual({
      ok: false,
      reason: "unknown-command",
    });
    expect(isAppCommandAvailable("noSuchCommand", context())).toBe(false);
  });

  it("overlay: 使える状態なら開閉し、phone と空の overlay では何もせず unavailable", () => {
    expect(runAppCommand("toggleLeftOverlay", context())).toEqual({
      ok: true,
    });
    expect(useLayoutStore.getState().openOverlay).toBe("left");

    useLayoutStore.setState({ openOverlay: null });
    expect(
      runAppCommand("toggleLeftOverlay", context({ phoneWorkspace: true })),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(runAppCommand("toggleRightOverlay", context())).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(useLayoutStore.getState().openOverlay).toBeNull();
  });

  it("export: genericProjectTransfer が無ければ呼ばない", () => {
    let calls = 0;
    const onToggleExport = () => void (calls += 1);
    expect(runAppCommand("toggleExport", context({ onToggleExport }))).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toBe(0);
    runAppCommand(
      "toggleExport",
      context({
        onToggleExport,
        runtimeCapabilities: { genericProjectTransfer: true },
      }),
    );
    expect(calls).toBe(1);
  });

  it("タブ切替は phone では unavailable", () => {
    expect(runAppCommand("nextTab", context({ phoneWorkspace: true }))).toEqual(
      {
        ok: false,
        reason: "unavailable",
      },
    );
  });

  it("固定キーの照合は Mod+Shift+E ／ F だけに当たる", () => {
    const event = (init: KeyboardEventInit) =>
      new KeyboardEvent("keydown", init);
    expect(
      matchesFixedKey(
        "toggleExport",
        event({ ctrlKey: true, shiftKey: true, key: "E" }),
      ),
    ).toBe(true);
    expect(
      matchesFixedKey("toggleExport", event({ ctrlKey: true, key: "e" })),
    ).toBe(false);
    expect(
      matchesFixedKey(
        "searchWorkspace",
        event({ ctrlKey: true, shiftKey: true, key: "F" }),
      ),
    ).toBe(true);
    expect(
      matchesFixedKey(
        "focusScenes",
        event({ ctrlKey: true, shiftKey: true, key: "F" }),
      ),
    ).toBe(false);
  });
});

describe("文脈の bridge", () => {
  it("host が登録した文脈で、キー以外の呼び出し元も run できる。解除は自分の登録だけを消す", () => {
    expect(runRegisteredAppCommand("openSettings")).toEqual({
      ok: false,
      reason: "no-host",
    });

    let opened = 0;
    const first = context({ onOpenSettings: () => void (opened += 1) });
    const unregisterFirst = registerCommandContext(first);
    expect(runRegisteredAppCommand("openSettings")).toEqual({ ok: true });
    expect(opened).toBe(1);

    // 再 mount で別の文脈に入れ替わった後に、古い cleanup が呼ばれても消さない。
    const second = context({ phoneWorkspace: true });
    const unregisterSecond = registerCommandContext(second);
    unregisterFirst();
    expect(resolveCommandContext().phoneWorkspace).toBe(true);

    unregisterSecond();
    expect(runRegisteredAppCommand("openSettings")).toEqual({
      ok: false,
      reason: "no-host",
    });
  });

  it("resolveCommandContext は登録が無くても何もしない既定の文脈を返し、上書きできる", () => {
    const resolved = resolveCommandContext({ phoneWorkspace: true });
    expect(resolved.phoneWorkspace).toBe(true);
    expect(resolved.runtimeCapabilities.genericProjectTransfer).toBe(false);
    expect(() => resolved.onOpenSettings()).not.toThrow();
  });
});
