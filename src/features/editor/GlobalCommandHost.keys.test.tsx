// @vitest-environment happy-dom
/**
 * GlobalCommandHost の「キー → 処理」の特性試験。
 *
 * コマンド registry への移行（挙動を変えない）の前後で同じ結果になることを固定する。
 * 内部の呼び出しではなく、store の状態・preventDefault・props の callback で確かめる。
 * overlay の開閉は GlobalCommandHost.test.tsx が持つ。
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const quiescence = vi.hoisted(() => ({ allowed: true }));

vi.mock("@/application/lifecycle/quiescenceLease", () => ({
  canScheduleQuiescenceMutation: () => quiescence.allowed,
}));

import { useResultsPanelStore } from "@/features/commandCenter";
import { useCompactNavigationStore } from "@/features/layout/adaptive/compactNavigationStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useInlineAiStore } from "./inlineAi/inlineAiStore";
import { GlobalCommandHost } from "./GlobalCommandHost";
import { useTabStore } from "./tabStore";

type Capabilities = import("@/runtime/runtimeCapabilities").RuntimeCapabilities;

const callbacks = {
  onToggleExport: vi.fn(),
  onOpenSettings: vi.fn(),
};

function mount(options: { phone?: boolean; transfer?: boolean } = {}) {
  const capabilities = {
    genericProjectTransfer: options.transfer ?? false,
  } as unknown as Capabilities;
  return render(
    <GlobalCommandHost
      phoneWorkspace={options.phone ?? false}
      runtimeCapabilities={capabilities}
      onToggleExport={callbacks.onToggleExport}
      onOpenSettings={callbacks.onOpenSettings}
    />,
  );
}

function rebind(overrides: Record<string, string>) {
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "keys.bindings": JSON.stringify(overrides) },
  }));
}

/** keydown を window に送り、preventDefault されたかを返す。 */
function press(init: KeyboardEventInit & { key: string; code: string }) {
  let prevented = false;
  act(() => {
    prevented = !fireEvent.keyDown(window, init);
  });
  return prevented;
}

function modAlt(letter: string) {
  return press({
    ctrlKey: true,
    altKey: true,
    key: letter.toLowerCase(),
    code: `Key${letter.toUpperCase()}`,
  });
}

function modShift(letter: string, extra: KeyboardEventInit = {}) {
  return press({
    ctrlKey: true,
    shiftKey: true,
    key: letter.toUpperCase(),
    code: `Key${letter.toUpperCase()}`,
    ...extra,
  });
}

const ctrlTab = (shift = false) =>
  press({ ctrlKey: true, shiftKey: shift, key: "Tab", code: "Tab" });
const ctrlBackslash = (shift = false) =>
  press({
    ctrlKey: true,
    shiftKey: shift,
    key: shift ? "|" : "\\",
    code: "Backslash",
  });

function resetTabs() {
  useTabStore.setState({
    tabs: [
      { nodeId: "scene-1", contentType: "scene", isPreview: false },
      { nodeId: "scene-2", contentType: "scene", isPreview: false },
      { nodeId: "scene-3", contentType: "scene", isPreview: false },
    ],
    activeTabId: "scene-1",
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
    splitDirection: "right",
  });
  useTreeStore.setState({ activeSceneId: "scene-1" });
}

function trackRaf() {
  const rafs: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafs.push(cb);
    return rafs.length;
  });
  return {
    rafs,
    flush: () =>
      act(() => {
        for (const cb of rafs.splice(0)) cb(0);
      }),
  };
}

const isActive = (
  panel: Parameters<
    ReturnType<typeof useLayoutStore.getState>["isPanelActive"]
  >[0],
) => useLayoutStore.getState().isPanelActive(panel);

beforeEach(() => {
  quiescence.allowed = true;
  callbacks.onToggleExport.mockClear();
  callbacks.onOpenSettings.mockClear();
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    openOverlay: null,
    maximizedPanelId: null,
  });
  useCompactNavigationStore.getState().reset();
  useResultsPanelStore.getState().reset();
  useResultsPanelStore.setState({ focusRequest: 0 });
  useInlineAiStore.getState().reset();
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "keys.bindings": "{}" },
  }));
  resetTabs();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("GlobalCommandHost — export（Mod+Shift+E、固定キー）", () => {
  it("genericProjectTransfer のときだけ export を開閉し、キーを consume する", () => {
    mount({ transfer: true });
    expect(modShift("e")).toBe(true);
    expect(callbacks.onToggleExport).toHaveBeenCalledTimes(1);
  });

  it("固定キーの照合は Mod と Shift だけを見る（Alt が付いていても発火する）", () => {
    mount({ transfer: true });
    expect(modShift("e", { altKey: true })).toBe(true);
    expect(callbacks.onToggleExport).toHaveBeenCalledTimes(1);
  });

  it("genericProjectTransfer が false なら consume せず、何もしない", () => {
    mount({ transfer: false });
    expect(modShift("e")).toBe(false);
    expect(callbacks.onToggleExport).not.toHaveBeenCalled();
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount({ transfer: true });
    expect(modShift("e")).toBe(false);
    expect(callbacks.onToggleExport).not.toHaveBeenCalled();
  });

  it("再割当より優先する（transfer 有効）。無効なら後段のパネルへ落ちる", () => {
    rebind({ focusScenes: "Mod+Shift+E" });
    const first = mount({ transfer: true });
    expect(modShift("e")).toBe(true);
    expect(callbacks.onToggleExport).toHaveBeenCalledTimes(1);
    expect(isActive("scenes")).toBe(false);
    first.unmount();

    mount({ transfer: false });
    expect(modShift("e")).toBe(true);
    expect(callbacks.onToggleExport).toHaveBeenCalledTimes(1);
    expect(isActive("scenes")).toBe(true);
  });
});

describe("GlobalCommandHost — 検索（Mod+Shift+F、固定キー）", () => {
  it("desktop: 検索パネルを出し、同期でフォーカスを要求する", () => {
    mount();
    expect(modShift("f")).toBe(true);
    expect(isActive("command-center-results")).toBe(true);
    expect(useResultsPanelStore.getState().focusRequest).toBe(1);
  });

  it("固定キーの照合は Mod と Shift だけを見る（Alt が付いていても発火する）", () => {
    mount();
    expect(modShift("f", { altKey: true })).toBe(true);
    expect(useResultsPanelStore.getState().focusRequest).toBe(1);
  });

  it("phone: compact navigation の search を開き、フォーカスは rAF の後", () => {
    const raf = trackRaf();
    mount({ phone: true });
    expect(modShift("f")).toBe(true);
    expect(useCompactNavigationStore.getState().activeSurface).toBe("search");
    expect(useResultsPanelStore.getState().focusRequest).toBe(0);
    expect(raf.rafs).toHaveLength(1);
    raf.flush();
    expect(useResultsPanelStore.getState().focusRequest).toBe(1);
    expect(isActive("command-center-results")).toBe(false);
  });

  it("すでに defaultPrevented なら何もせず、後段（パネル）にも落ちない", () => {
    rebind({ focusScenes: "Mod+Shift+F" });
    const early = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", early);
    try {
      mount();
      modShift("f");
    } finally {
      window.removeEventListener("keydown", early);
    }
    expect(useResultsPanelStore.getState().focusRequest).toBe(0);
    expect(isActive("command-center-results")).toBe(false);
    expect(isActive("scenes")).toBe(false);
  });

  it("再割当されたパネルより優先する", () => {
    rebind({ focusScenes: "Mod+Shift+F" });
    mount();
    expect(modShift("f")).toBe(true);
    expect(useResultsPanelStore.getState().focusRequest).toBe(1);
    expect(isActive("scenes")).toBe(false);
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount();
    expect(modShift("f")).toBe(false);
    expect(useResultsPanelStore.getState().focusRequest).toBe(0);
  });
});

describe("GlobalCommandHost — パネルのショートカット", () => {
  it("desktop: トグルして consume する", () => {
    mount();
    expect(modAlt("S")).toBe(true);
    expect(isActive("scenes")).toBe(true);
    expect(modAlt("S")).toBe(true);
    expect(isActive("scenes")).toBe(false);
  });

  it("再割当したキーで動き、元のキーは効かない", () => {
    rebind({ focusScenes: "Mod+Alt+Y" });
    mount();
    expect(modAlt("S")).toBe(false);
    expect(isActive("scenes")).toBe(false);
    expect(modAlt("Y")).toBe(true);
    expect(isActive("scenes")).toBe(true);
  });

  it("同じキーを複数のパネルに割り当てたら、PANEL_COMMANDS の先頭が勝つ", () => {
    rebind({ focusCodex: "Mod+Alt+S" });
    mount();
    expect(modAlt("S")).toBe(true);
    expect(isActive("scenes")).toBe(true);
    expect(isActive("codex")).toBe(false);
  });

  it("設定を開くより優先する", () => {
    rebind({ openSettings: "Mod+Alt+S" });
    mount();
    expect(modAlt("S")).toBe(true);
    expect(isActive("scenes")).toBe(true);
    expect(callbacks.onOpenSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["S", "scenes"],
    ["X", "codex"],
    ["Q", "codex"],
    ["C", "ai"],
    ["H", "ai"],
    ["N", "more"],
    ["L", "more"],
    ["M", "more"],
  ])(
    "phone: Mod+Alt+%s は surface %s を開き、パネルは触らず consume する",
    (letter, surface) => {
      mount({ phone: true });
      expect(modAlt(letter)).toBe(true);
      expect(useCompactNavigationStore.getState().activeSurface).toBe(surface);
      expect(isActive("scenes")).toBe(false);
      expect(isActive("codex")).toBe(false);
    },
  );

  it("codex-quick: トグルの後に rAF で開く側を呼ぶ（閉じても rAF で開き直す）", () => {
    const raf = trackRaf();
    mount();
    expect(modAlt("Q")).toBe(true);
    expect(isActive("codex-quick")).toBe(true);
    expect(raf.rafs).toHaveLength(1);
    raf.flush();
    expect(isActive("codex-quick")).toBe(true);

    expect(modAlt("Q")).toBe(true);
    expect(isActive("codex-quick")).toBe(false);
    expect(raf.rafs).toHaveLength(1);
    raf.flush();
    expect(isActive("codex-quick")).toBe(true);
  });

  it("phone では codex-quick も rAF を使わない", () => {
    const raf = trackRaf();
    mount({ phone: true });
    modAlt("Q");
    expect(raf.rafs).toHaveLength(0);
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount();
    expect(modAlt("S")).toBe(false);
    expect(isActive("scenes")).toBe(false);
  });

  it("overlay のキーと同じ割当は、phone でも空 overlay でも後段に落ちず consume しない", () => {
    rebind({ focusScenes: "Mod+Alt+[" });
    const phone = mount({ phone: true });
    expect(
      press({ ctrlKey: true, altKey: true, key: "[", code: "BracketLeft" }),
    ).toBe(false);
    expect(useCompactNavigationStore.getState().activeSurface).toBe("editor");
    phone.unmount();

    // overlay が空の desktop。
    mount();
    expect(
      press({ ctrlKey: true, altKey: true, key: "[", code: "BracketLeft" }),
    ).toBe(false);
    expect(isActive("scenes")).toBe(false);
  });
});

describe("GlobalCommandHost — 設定を開く（Mod+Alt+,）", () => {
  const comma = () =>
    press({ ctrlKey: true, altKey: true, key: ",", code: "Comma" });

  it("onOpenSettings を呼び、consume する（phone でも）", () => {
    const first = mount();
    expect(comma()).toBe(true);
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    first.unmount();

    mount({ phone: true });
    expect(comma()).toBe(true);
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("分割より優先する", () => {
    rebind({ splitVertical: "Mod+Alt+," });
    mount();
    expect(comma()).toBe(true);
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(useTabStore.getState().secondaryGroupOpen).toBe(false);
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount();
    expect(comma()).toBe(false);
    expect(callbacks.onOpenSettings).not.toHaveBeenCalled();
  });
});

describe("GlobalCommandHost — 分割（Mod+\\ ／ Mod+Shift+\\）", () => {
  it("アクティブなタブを右に分割する", () => {
    mount();
    expect(ctrlBackslash()).toBe(true);
    const tabs = useTabStore.getState();
    expect(tabs.secondaryGroupOpen).toBe(true);
    expect(tabs.splitDirection).toBe("right");
    expect(tabs.secondaryActiveTabId).toBe("scene-1");
  });

  it("Shift 付きは下に分割する", () => {
    mount();
    expect(ctrlBackslash(true)).toBe(true);
    const tabs = useTabStore.getState();
    expect(tabs.secondaryGroupOpen).toBe(true);
    expect(tabs.splitDirection).toBe("below");
    expect(tabs.secondaryActiveTabId).toBe("scene-1");
  });

  it("アクティブなタブが無ければ空の secondary group を作る", () => {
    useTabStore.setState({ tabs: [], activeTabId: null });
    mount();
    expect(ctrlBackslash(true)).toBe(true);
    const tabs = useTabStore.getState();
    expect(tabs.secondaryGroupOpen).toBe(true);
    expect(tabs.splitDirection).toBe("below");
    expect(tabs.activeGroupIndex).toBe(1);
    expect(tabs.secondaryActiveTabId).toBeNull();
  });

  it("phone では consume するがタブは変えない", () => {
    mount({ phone: true });
    expect(ctrlBackslash()).toBe(true);
    expect(useTabStore.getState().secondaryGroupOpen).toBe(false);
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount();
    expect(ctrlBackslash()).toBe(false);
    expect(useTabStore.getState().secondaryGroupOpen).toBe(false);
  });
});

describe("GlobalCommandHost — タブ切替（Control+Tab ／ Control+Shift+Tab）", () => {
  it("次へ進み、末尾から先頭へ巻き戻る", () => {
    mount();
    expect(ctrlTab()).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("scene-2");
    expect(useTreeStore.getState().activeSceneId).toBe("scene-2");
    ctrlTab();
    ctrlTab();
    expect(useTabStore.getState().activeTabId).toBe("scene-1");
  });

  it("Shift 付きは前へ戻り、先頭から末尾へ巻き戻る", () => {
    mount();
    expect(ctrlTab(true)).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("scene-3");
  });

  it("secondary group が active なら、その中で切り替える", () => {
    useTabStore.setState({
      secondaryTabs: [
        { nodeId: "scene-4", contentType: "scene", isPreview: false },
        { nodeId: "scene-5", contentType: "scene", isPreview: false },
      ],
      secondaryActiveTabId: "scene-4",
      secondaryGroupOpen: true,
      activeGroupIndex: 1,
    });
    mount();
    expect(ctrlTab()).toBe(true);
    const tabs = useTabStore.getState();
    expect(tabs.secondaryActiveTabId).toBe("scene-5");
    expect(tabs.activeTabId).toBe("scene-1");
  });

  it("タブが 2 枚未満でも consume する", () => {
    useTabStore.setState({
      tabs: [{ nodeId: "scene-1", contentType: "scene", isPreview: false }],
    });
    mount();
    expect(ctrlTab()).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("scene-1");
  });

  it("phone では consume せず、タブも変えない", () => {
    mount({ phone: true });
    expect(ctrlTab()).toBe(false);
    expect(useTabStore.getState().activeTabId).toBe("scene-1");
  });

  it("静止待ちでは何もせず consume もしない", () => {
    quiescence.allowed = false;
    mount();
    expect(ctrlTab()).toBe(false);
    expect(useTabStore.getState().activeTabId).toBe("scene-1");
  });
});

describe("GlobalCommandHost — undo／redo（別の listener）", () => {
  const undo = vi.fn(() => Promise.resolve());
  const redo = vi.fn(() => Promise.resolve());
  const original = {
    undo: useGlobalHistoryStore.getState().undo,
    redo: useGlobalHistoryStore.getState().redo,
  };
  const ctrlZ = (shift = false) =>
    press({ ctrlKey: true, shiftKey: shift, key: "z", code: "KeyZ" });

  beforeEach(() => {
    undo.mockClear();
    redo.mockClear();
    useGlobalHistoryStore.setState({ undo, redo });
  });
  afterEach(() => {
    useGlobalHistoryStore.setState(original);
    document.body.replaceChildren();
  });

  it("Ctrl+Z で undo、Ctrl+Shift+Z と Ctrl+Y で redo し、consume する", () => {
    mount();
    expect(ctrlZ()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(ctrlZ(true)).toBe(true);
    expect(redo).toHaveBeenCalledTimes(1);
    expect(press({ ctrlKey: true, key: "y", code: "KeyY" })).toBe(true);
    expect(redo).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("静止待ちの guard は無く、静止待ちでも動く", () => {
    quiescence.allowed = false;
    mount();
    expect(ctrlZ()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it("入力欄と contenteditable の中では何もしない", () => {
    mount();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(ctrlZ()).toBe(false);
    input.remove();

    const host = document.createElement("div");
    host.className = "ProseMirror";
    host.tabIndex = 0;
    document.body.append(host);
    host.focus();
    expect(ctrlZ()).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });

  it("先に preventDefault されていたら何もしない", () => {
    const early = (event: Event) => event.preventDefault();
    window.addEventListener("keydown", early);
    try {
      mount();
      ctrlZ();
    } finally {
      window.removeEventListener("keydown", early);
    }
    expect(undo).not.toHaveBeenCalled();
  });

  it("グローバルのキー処理が先に consume した同じキーでは、undo は動かない", () => {
    rebind({ openSettings: "Mod+Z" });
    mount();
    ctrlZ();
    expect(callbacks.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
  });

  it("タブ切替は別の listener なので、同じキーなら undo と両方動く", () => {
    rebind({ nextTab: "Mod+Z" });
    mount();
    ctrlZ();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(useTabStore.getState().activeTabId).toBe("scene-2");
  });
});

describe("GlobalCommandHost — listener の数", () => {
  it("keydown の listener は 3 本（キー全般、undo／redo、タブ切替）", () => {
    const add = vi.spyOn(window, "addEventListener");
    mount();
    const keydown = add.mock.calls.filter(([type]) => type === "keydown");
    expect(keydown).toHaveLength(3);
  });
});
