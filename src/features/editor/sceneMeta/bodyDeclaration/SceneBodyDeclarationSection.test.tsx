// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import { registerQuiescenceParticipant } from "@/application/lifecycle/quiescenceParticipants";
import { createEditorInstanceId } from "@/features/editor/document/documentKey";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import {
  cancelPendingSynopsisSave,
  schedulePendingSynopsisSave,
} from "@/features/editor/pendingSynopsisSaves";
import type { TreeNodeData } from "@/features/tree/treeStore";

const { invokeMock, uiState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  uiState: { enabled: true },
}));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("./bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => uiState.enabled,
}));

import { SceneBodyDeclarationSection } from "./SceneBodyDeclarationSection";
import {
  BODY_DECLARATION_AXES,
  BODY_DECLARATION_BLOCKERS,
  BODY_DECLARATION_EXPIRY_GROUPS,
  BODY_DECLARATION_REFUSAL_CODES,
  BODY_DECLARATION_UNAVAILABLE_REASONS,
} from "./bodyDeclarationTypes";
import { axe } from "@/test-utils/axe";

const STATE = "narrative_scene_body_declaration_state";
const DECLARE = "narrative_scene_body_declaration_declare";
const REVOKE = "narrative_scene_body_declaration_revoke";
const instance = createEditorInstanceId("test");
const SECRET_TOKEN = "opaque-token-should-never-render";

const noneWire = (blocker: string | null = null) => ({
  occ: blocker === null ? { scopeVersion: 3, scopeToken: SECRET_TOKEN } : null,
  declarationToken: null,
  state: { kind: "none", blocker },
});
const declaredWire = (
  effective: boolean,
  expiredBy: string[] = [],
  blocker: string | null = null,
) => ({
  occ: { scopeVersion: 3, scopeToken: SECRET_TOKEN },
  declarationToken: SECRET_TOKEN,
  state: { kind: "declared", effective, expiredBy, blocker },
});

function refusal(code: string): Error {
  return new Error(`NEX_BODY_DECLARATION_REFUSED:${code}`);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const calls = (command: string) =>
  invokeMock.mock.calls.filter((call) => call[0] === command);

function makeNode(overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id: "scene-1",
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: "Scene one",
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    version: 1,
    createdAt: "2026-10-23T00:00:00Z",
    updatedAt: "2026-10-23T00:00:00Z",
    ...overrides,
  };
}

type Native = {
  state: () => unknown;
  declare: () => unknown;
  revoke: () => unknown;
};
let native: Native;

function installNative(initial: Partial<Native> = {}) {
  native = {
    state: () => noneWire(),
    declare: () => ({ outcome: "declared" }),
    revoke: () => ({ outcome: "revoked" }),
    ...initial,
  };
  invokeMock.mockImplementation(async (command: string) => {
    const handler =
      command === STATE
        ? native.state
        : command === DECLARE
          ? native.declare
          : command === REVOKE
            ? native.revoke
            : null;
    if (handler === null) throw new Error(`unexpected command ${command}`);
    const value = handler();
    if (value instanceof Error) throw value;
    return value;
  });
}

function renderSection(node = makeNode(), refreshKey: string | number = 0) {
  const view = render(
    <SceneBodyDeclarationSection
      node={node}
      workspacePath="/workspace"
      refreshKey={refreshKey}
    />,
  );
  return {
    ...view,
    update: (next: TreeNodeData, key: string | number = refreshKey) =>
      view.rerender(
        <SceneBodyDeclarationSection
          node={next}
          workspacePath="/workspace"
          refreshKey={key}
        />,
      ),
  };
}

const root = () => screen.queryByTestId("scene-body-declaration");
const stateOf = () => root()?.getAttribute("data-state") ?? null;
const declareButton = () =>
  screen.queryByTestId("body-declaration-declare") as HTMLButtonElement | null;
const revokeButton = () =>
  screen.queryByTestId("body-declaration-revoke") as HTMLButtonElement | null;
const axisBox = (axis: string) =>
  within(screen.getByTestId(`body-declaration-axis-${axis}`)).getByRole(
    "checkbox",
  ) as HTMLInputElement;
const confirmAll = () => {
  for (const axis of BODY_DECLARATION_AXES) fireEvent.click(axisBox(axis));
};
async function ready(state: string) {
  await waitFor(() => expect(stateOf()).toBe(state));
}

beforeEach(async () => {
  invokeMock.mockReset();
  uiState.enabled = true;
  await i18n.changeLanguage("ja");
  installNative();
});
afterEach(() => {
  cleanup();
  useEditorSessionStore.getState().resetForProject();
  vi.restoreAllMocks();
});

describe("visibility (G)", () => {
  it("renders nothing and calls no IPC while the UI constant is off", async () => {
    uiState.enabled = false;
    const { container, update } = renderSection();
    update(makeNode({ version: 2 }), 1);
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.firstChild).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each([
    ["gate-closed", refusal("gate-closed")],
    ["workspace-mismatch", refusal("workspace-mismatch")],
    [
      "egress denied",
      new Error("D2A_EGRESS_DENIED: caller identity is missing"),
    ],
  ])(
    "renders nothing when the read is refused (%s), and stays quiet",
    async (_label, error) => {
      installNative({ state: () => error });
      const { container } = renderSection();
      await waitFor(() => expect(calls(STATE)).toHaveLength(1));
      await act(async () => {
        await Promise.resolve();
      });
      expect(container.firstChild).toBeNull();
      expect(screen.queryByTestId("body-declaration-declare")).toBeNull();
      expect(screen.queryByTestId("body-declaration-revoke")).toBeNull();
      expect(calls(DECLARE)).toHaveLength(0);
      expect(calls(REVOKE)).toHaveLength(0);
    },
  );
});

describe("the draft (U-1, U-7, U-8)", () => {
  it("shows a draft with nothing confirmed when there is no declaration", async () => {
    renderSection();
    await ready("draft");
    expect(
      screen.getByTestId("body-declaration-state-label"),
    ).toHaveTextContent("草案");
    expect(BODY_DECLARATION_AXES).toHaveLength(5);
    for (const axis of BODY_DECLARATION_AXES) {
      expect(axisBox(axis).checked).toBe(false);
      expect(axisBox(axis).disabled).toBe(false);
    }
    expect(declareButton()).toBeDisabled();
    expect(revokeButton()).toBeNull();
    expect(screen.getByTestId("scene-body-declaration")).toHaveTextContent(
      "未配置のビート",
    );
  });

  it("enables declare only when all five axes are confirmed", async () => {
    renderSection();
    await ready("draft");
    for (const axis of BODY_DECLARATION_AXES.slice(0, 4)) {
      fireEvent.click(axisBox(axis));
      expect(declareButton()).toBeDisabled();
    }
    fireEvent.click(axisBox("pov"));
    expect(declareButton()).toBeEnabled();
    fireEvent.click(axisBox("reveal"));
    expect(declareButton()).toBeDisabled();
    fireEvent.click(declareButton() as HTMLButtonElement);
    expect(calls(DECLARE)).toHaveLength(0);
  });

  it("keeps the draft out of storage and drops it when the Scene changes", async () => {
    const setLocal = vi.spyOn(Storage.prototype, "setItem");
    const { update } = renderSection();
    await ready("draft");
    fireEvent.click(axisBox("story"));
    fireEvent.click(axisBox("pov"));
    update(makeNode({ id: "scene-2" }));
    await ready("draft");
    for (const axis of BODY_DECLARATION_AXES) {
      expect(axisBox(axis).checked).toBe(false);
    }
    expect(setLocal).not.toHaveBeenCalled();
    expect(calls(STATE)).toHaveLength(2);
  });
});

describe("the three states (U-2 to U-6)", () => {
  it("shows a currently effective declaration without promising a display", async () => {
    installNative({ state: () => declaredWire(true) });
    renderSection();
    await ready("effective");
    const text = screen.getByTestId("scene-body-declaration").textContent;
    expect(text).toContain("現在有効");
    expect(text).toContain("表示は保証されません");
    expect(text).toContain("Related Scenes");
    expect(text).toContain("失効します");
    expect(screen.queryByTestId("body-declaration-form")).toBeNull();
    expect(revokeButton()).toBeEnabled();
  });

  it.each(BODY_DECLARATION_EXPIRY_GROUPS)(
    "names the %s group of an expired declaration and asks to declare again",
    async (group) => {
      installNative({ state: () => declaredWire(false, [group]) });
      renderSection();
      await ready("expired");
      const banner = screen.getByTestId("body-declaration-banner");
      expect(
        within(banner).getByTestId(`body-declaration-expiry-${group}`),
      ).toHaveTextContent(
        (
          ja.editor.sceneDetail.bodyDeclaration.expiry as Record<string, string>
        )[group],
      );
      for (const other of BODY_DECLARATION_EXPIRY_GROUPS) {
        if (other === group) continue;
        expect(
          within(banner).queryByTestId(`body-declaration-expiry-${other}`),
        ).toBeNull();
      }
      expect(banner).toHaveTextContent("改めて宣言");
      expect(banner.textContent).not.toContain("表示されえます");
      expect(
        screen.getByTestId("body-declaration-state-label"),
      ).toHaveTextContent("失効");
      expect(declareButton()).toHaveTextContent("改めて宣言する");
      expect(revokeButton()).toBeEnabled();
    },
  );

  it("each expiry group has its own message", () => {
    const messages = Object.values(
      ja.editor.sceneDetail.bodyDeclaration.expiry,
    );
    expect(new Set(messages).size).toBe(BODY_DECLARATION_EXPIRY_GROUPS.length);
  });

  it("names a blocker first when an expired declaration also cannot be redeclared", async () => {
    installNative({ state: () => declaredWire(false, [], "veto-pov") });
    renderSection();
    await ready("expired");
    expect(screen.getByTestId("body-declaration-blocker")).toHaveTextContent(
      "視点（POV）の記録",
    );
    for (const axis of BODY_DECLARATION_AXES) {
      expect(axisBox(axis).disabled).toBe(true);
    }
    expect(declareButton()).toBeDisabled();
  });

  it("announces a declaration that turned invalid in a live region", async () => {
    let wire: unknown = declaredWire(true);
    installNative({ state: () => wire });
    renderSection();
    await ready("effective");
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).not.toHaveTextContent("失効しました");
    wire = declaredWire(false, ["content"]);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await ready("expired");
    expect(screen.getByRole("status")).toHaveTextContent("宣言が失効しました");
    expect(screen.getByTestId("body-declaration-banner")).toHaveAttribute(
      "data-became-invalid",
      "true",
    );
  });

  it("never shows effective while loading, failing or unknown", async () => {
    const gate = deferred<unknown>();
    installNative({ state: () => gate.promise });
    renderSection();
    expect(stateOf()).toBe("loading");
    expect(
      screen.getByTestId("scene-body-declaration").textContent,
    ).not.toContain("現在有効");
    expect(declareButton()).toBeNull();
    expect(revokeButton()).toBeNull();
    gate.reject(refusal("store-failure"));
    await ready("unknown");
    expect(
      screen.getByTestId("scene-body-declaration").textContent,
    ).not.toContain("現在有効");
    expect(declareButton()).toBeNull();
    expect(revokeButton()).toBeNull();
    native.state = () => declaredWire(true);
    fireEvent.click(screen.getByTestId("body-declaration-reload"));
    await ready("effective");
  });

  it("explains a stored declaration that cannot be read and still allows a revoke", async () => {
    installNative({
      state: () => ({
        occ: null,
        declarationToken: SECRET_TOKEN,
        state: { kind: "unavailable", reason: "malformed", blocker: null },
      }),
    });
    renderSection();
    await ready("unavailable");
    expect(screen.getByTestId("body-declaration-banner")).toHaveTextContent(
      "宣言の記録が壊れています",
    );
    expect(declareButton()).toBeNull();
    expect(revokeButton()).toBeEnabled();
  });
});

describe("declaring (U-9)", () => {
  it("only announces Main's dialog and sends the closed payload", async () => {
    const gate = deferred<unknown>();
    installNative({ declare: () => gate.promise });
    renderSection();
    await ready("draft");
    confirmAll();
    expect(screen.getByTestId("scene-body-declaration")).toHaveTextContent(
      "確認ダイアログが開きます",
    );
    fireEvent.click(declareButton() as HTMLButtonElement);
    await waitFor(() => expect(calls(DECLARE)).toHaveLength(1));
    const args = calls(DECLARE)[0][1] as {
      expectedWorkspacePath: string;
      payload: Record<string, unknown>;
    };
    expect(Object.keys(args).sort()).toEqual([
      "expectedWorkspacePath",
      "payload",
    ]);
    expect(Object.keys(args.payload).sort()).toEqual([
      "expected",
      "projectId",
      "requestId",
      "sceneId",
      "values",
    ]);
    // While Main's dialog is open the panel waits and offers nothing else.
    expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
      "確認ダイアログを待っています",
    );
    expect(declareButton()).toBeDisabled();
    expect(revokeButton()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.body.textContent).not.toMatch(/承認しました|approved/i);
    native.state = () => declaredWire(true);
    await act(async () => {
      gate.resolve({ outcome: "declared" });
    });
    await ready("effective");
    expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
      "宣言しました。",
    );
    expect(calls(STATE)).toHaveLength(2);
  });

  it.each([
    ["MAIN_GRANT_CANCELLED", "確認ダイアログがキャンセルされました"],
    ["MAIN_GRANT_EXPIRED", "確認ダイアログの期限が切れました"],
    ["MAIN_GRANT_REVOKED", "確認が取り消されました"],
  ])(
    "says nothing was declared after %s and reads again",
    async (code, text) => {
      installNative({ declare: () => new Error(code) });
      renderSection();
      await ready("draft");
      confirmAll();
      fireEvent.click(declareButton() as HTMLButtonElement);
      await waitFor(() =>
        expect(
          screen.getByTestId("body-declaration-outcome"),
        ).toHaveTextContent("宣言されませんでした。"),
      );
      expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
        text,
      );
      await waitFor(() => expect(calls(STATE)).toHaveLength(2));
      expect(stateOf()).toBe("draft");
      // The author confirms again for the next attempt.
      for (const axis of BODY_DECLARATION_AXES) {
        expect(axisBox(axis).checked).toBe(false);
      }
    },
  );

  it("never renders a raw error message", async () => {
    installNative({
      declare: () =>
        new Error("EACCES: permission denied, open '/home/secret/novel.db'"),
    });
    renderSection();
    await ready("draft");
    confirmAll();
    fireEvent.click(declareButton() as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
        "宣言されませんでした。",
      ),
    );
    expect(document.body.textContent).not.toContain("/home/secret");
    expect(document.body.textContent).not.toContain("EACCES");
  });
});

describe("revoking (U-10, U-11)", () => {
  it("revokes in one step, with no confirmation and no undo entry", async () => {
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmSpy);
    installNative({ state: () => declaredWire(true) });
    renderSection();
    await ready("effective");
    native.state = () => noneWire();
    fireEvent.click(revokeButton() as HTMLButtonElement);
    await waitFor(() => expect(calls(REVOKE)).toHaveLength(1));
    expect(calls(REVOKE)[0][1]).toEqual({
      expectedWorkspacePath: "/workspace",
      payload: {
        projectId: "project-1",
        sceneId: "scene-1",
        declarationToken: SECRET_TOKEN,
        requestId: expect.any(String),
      },
    });
    await ready("draft");
    expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
      "宣言を取り消しました",
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    vi.unstubAllGlobals();
  });

  it.each([
    ["no-declaration", "取り消す宣言はありませんでした"],
    ["declaration-changed", "何も取り消していません"],
  ])("explains %s and reads again", async (outcome, text) => {
    installNative({
      state: () => declaredWire(true),
      revoke: () => ({ outcome }),
    });
    renderSection();
    await ready("effective");
    fireEvent.click(revokeButton() as HTMLButtonElement);
    await waitFor(() =>
      expect(screen.getByTestId("body-declaration-outcome")).toHaveTextContent(
        text,
      ),
    );
    await waitFor(() => expect(calls(STATE)).toHaveLength(2));
  });

  it("runs one operation at a time", async () => {
    installNative({ state: () => declaredWire(true) });
    renderSection();
    await ready("effective");
    const gate = deferred<unknown>();
    native.revoke = () => gate.promise;
    fireEvent.click(revokeButton() as HTMLButtonElement);
    await waitFor(() => expect(revokeButton()).toBeDisabled());
    fireEvent.click(revokeButton() as HTMLButtonElement);
    expect(calls(REVOKE)).toHaveLength(1);
    await act(async () => {
      gate.resolve({ outcome: "revoked" });
    });
  });

  it("uses a fresh request id for each revoke, even for the same declaration", async () => {
    installNative({
      state: () => declaredWire(true),
      revoke: () => ({ outcome: "declaration-changed" }),
    });
    renderSection();
    await ready("effective");
    fireEvent.click(revokeButton() as HTMLButtonElement);
    await waitFor(() => expect(calls(STATE)).toHaveLength(2));
    await ready("effective");
    fireEvent.click(revokeButton() as HTMLButtonElement);
    await waitFor(() => expect(calls(REVOKE)).toHaveLength(2));
    const ids = calls(REVOKE).map(
      (call) =>
        (call[1] as { payload: { requestId: string } }).payload.requestId,
    );
    expect(new Set(ids).size).toBe(2);
  });
});

describe("restart required (U-12)", () => {
  it("disables declare and revoke and asks for a restart", async () => {
    installNative({ state: () => refusal("restart-required") });
    renderSection();
    await ready("restart-required");
    expect(screen.getByTestId("body-declaration-banner")).toHaveTextContent(
      "再起動",
    );
    expect(declareButton()).toBeNull();
    expect(revokeButton()).toBeNull();
    expect(
      screen
        .queryAllByRole("checkbox")
        .filter((box) => !(box as HTMLInputElement).disabled),
    ).toHaveLength(0);
  });
});

describe("what is never rendered (U-13)", () => {
  it.each([
    ["draft", () => noneWire()],
    ["effective", () => declaredWire(true)],
    ["expired", () => declaredWire(false, ["content", "scope"])],
  ])(
    "shows no token, digest, excerpt or body in the %s state",
    async (name, wire) => {
      installNative({ state: wire });
      const { container } = renderSection(
        makeNode({ title: "Secret Title 7 / 本文の一節" }),
      );
      await ready(name);
      expect(container.innerHTML).not.toContain(SECRET_TOKEN);
      expect(container.innerHTML).not.toContain("Secret Title 7");
      expect(container.innerHTML).not.toMatch(/sha256|digest/i);
    },
  );
});

describe("blockers (U-14)", () => {
  it.each(BODY_DECLARATION_BLOCKERS)(
    "disables the axes and names the reason for %s",
    async (blocker) => {
      installNative({ state: () => noneWire(blocker) });
      renderSection();
      await ready("draft");
      const message = (
        ja.editor.sceneDetail.bodyDeclaration.code as Record<string, string>
      )[blocker];
      expect(screen.getByTestId("body-declaration-blocker")).toHaveTextContent(
        message,
      );
      for (const axis of BODY_DECLARATION_AXES) {
        expect(axisBox(axis).disabled).toBe(true);
      }
      expect(declareButton()).toBeDisabled();
    },
  );
});

describe("unsaved edits (P2-3)", () => {
  it("keeps declare disabled while the editor has unsaved body edits", async () => {
    renderSection();
    await ready("draft");
    confirmAll();
    expect(declareButton()).toBeEnabled();
    act(() => {
      useEditorSessionStore
        .getState()
        .setDocumentDirty("scene-1", true, instance);
    });
    expect(declareButton()).toBeDisabled();
    expect(screen.getByTestId("body-declaration-unsaved")).toHaveTextContent(
      "保存を待ってください",
    );
    act(() => {
      useEditorSessionStore
        .getState()
        .setDocumentDirty("scene-1", false, instance);
    });
    expect(declareButton()).toBeEnabled();
    expect(screen.queryByTestId("body-declaration-unsaved")).toBeNull();
  });

  it("ignores unsaved edits of another Scene", async () => {
    renderSection();
    await ready("draft");
    confirmAll();
    act(() => {
      useEditorSessionStore
        .getState()
        .setDocumentDirty("scene-9", true, instance);
    });
    expect(declareButton()).toBeEnabled();
  });

  it("keeps declare disabled while a synopsis save is pending", async () => {
    renderSection();
    await ready("draft");
    confirmAll();
    const owner = Symbol("test");
    act(() => {
      schedulePendingSynopsisSave({
        key: "tree-synopsis\u0000scene-1",
        owner,
        value: "x",
        persist: async () => {},
        delayMs: 60_000,
      });
    });
    expect(declareButton()).toBeDisabled();
    act(() => {
      cancelPendingSynopsisSave("tree-synopsis\u0000scene-1", owner);
    });
    expect(declareButton()).toBeEnabled();
  });

  it("refuses at the press when a draft that does not announce itself is dirty", async () => {
    let dirty = false;
    const unregister = registerQuiescenceParticipant({
      id: "editor-title:scene-1",
      scope: { kind: "tree-node", entityId: "scene-1" },
      isDirty: () => dirty,
      flush: async () => {},
    });
    renderSection();
    await ready("draft");
    confirmAll();
    expect(declareButton()).toBeEnabled();
    dirty = true;
    fireEvent.click(declareButton() as HTMLButtonElement);
    expect(calls(DECLARE)).toHaveLength(0);
    expect(screen.getByTestId("body-declaration-unsaved")).toBeInTheDocument();
    dirty = false;
    fireEvent.click(axisBox("pov"));
    fireEvent.click(axisBox("pov"));
    expect(screen.queryByTestId("body-declaration-unsaved")).toBeNull();
    fireEvent.click(declareButton() as HTMLButtonElement);
    await waitFor(() => expect(calls(DECLARE)).toHaveLength(1));
    unregister();
  });
});

describe("locale (U-15)", () => {
  const leaves = (value: unknown, path = ""): string[] =>
    value !== null && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).flatMap(
          ([key, child]) => leaves(child, path ? `${path}.${key}` : key),
        )
      : [path];
  const textOf = (locale: unknown, path: string): unknown =>
    path
      .split(".")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown> | undefined)?.[key],
        (locale as typeof ja).editor.sceneDetail.bodyDeclaration,
      );

  it("has the same keys in en and ja, none of them empty", () => {
    const jaKeys = leaves(ja.editor.sceneDetail.bodyDeclaration).sort();
    const enKeys = leaves(en.editor.sceneDetail.bodyDeclaration).sort();
    expect(enKeys).toEqual(jaKeys);
    for (const key of jaKeys) {
      expect(String(textOf(ja, key)).length).toBeGreaterThan(0);
      expect(String(textOf(en, key)).length).toBeGreaterThan(0);
    }
  });

  it("has a message for every closed code, group, reason and axis", () => {
    for (const locale of [ja, en]) {
      for (const code of BODY_DECLARATION_REFUSAL_CODES) {
        expect(textOf(locale, `code.${code}`)).toEqual(expect.any(String));
      }
      for (const group of BODY_DECLARATION_EXPIRY_GROUPS) {
        expect(textOf(locale, `expiry.${group}`)).toEqual(expect.any(String));
      }
      for (const reason of BODY_DECLARATION_UNAVAILABLE_REASONS) {
        expect(textOf(locale, `unavailable.${reason}`)).toEqual(
          expect.any(String),
        );
      }
      for (const axis of BODY_DECLARATION_AXES) {
        expect(textOf(locale, `axis.${axis}.label`)).toEqual(
          expect.any(String),
        );
        expect(textOf(locale, `axis.${axis}.help`)).toEqual(expect.any(String));
      }
    }
  });

  it("shows the English text when the language is English", async () => {
    await i18n.changeLanguage("en");
    installNative({ state: () => declaredWire(true) });
    renderSection();
    await ready("effective");
    expect(screen.getByTestId("scene-body-declaration")).toHaveTextContent(
      "Display is not guaranteed",
    );
  });
});

describe("accessibility", () => {
  it.each([
    ["draft", () => noneWire()],
    ["expired", () => declaredWire(false, ["scope"])],
  ])("has no axe violations in the %s state", async (name, wire) => {
    installNative({ state: wire });
    const { container } = renderSection();
    await ready(name);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
