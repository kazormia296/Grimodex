// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, uiState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  uiState: { enabled: true },
}));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("./bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => uiState.enabled,
}));

import {
  useSceneBodyDeclaration,
  type UseSceneBodyDeclarationInput,
} from "./useSceneBodyDeclaration";
import type { ConfirmedAxes } from "./bodyDeclarationTypes";

const STATE = "narrative_scene_body_declaration_state";
const DECLARE = "narrative_scene_body_declaration_declare";
const REVOKE = "narrative_scene_body_declaration_revoke";

const ALL: ConfirmedAxes = {
  story: true,
  auto: true,
  phase: true,
  reveal: true,
  pov: true,
};

const noneWire = (blocker: string | null = null) => ({
  occ: blocker === null ? { scopeVersion: 3, scopeToken: "st" } : null,
  declarationToken: null,
  state: { kind: "none", blocker },
});
const declaredWire = (
  effective: boolean,
  expiredBy: string[] = [],
  token = "dt",
) => ({
  occ: { scopeVersion: 3, scopeToken: "st" },
  declarationToken: token,
  state: { kind: "declared", effective, expiredBy, blocker: null },
});

function refusal(code: string): Error {
  return new Error(`NEX_BODY_DECLARATION_REFUSED:${code}`);
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
function deferred<T>(): Deferred<T> {
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

const BASE: UseSceneBodyDeclarationInput = {
  workspacePath: "/workspace",
  projectId: "project-1",
  sceneId: "scene-1",
  version: 1,
  updatedAt: "2026-10-23T00:00:00Z",
  title: "Scene",
  refreshKey: 0,
};

function mount(initial: UseSceneBodyDeclarationInput = BASE) {
  return renderHook(
    (props: UseSceneBodyDeclarationInput) => useSceneBodyDeclaration(props),
    { initialProps: initial },
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  uiState.enabled = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("availability", () => {
  it("does nothing and invokes nothing while the UI constant is off", async () => {
    uiState.enabled = false;
    const { result, rerender } = mount();
    rerender({ ...BASE, version: 2, refreshKey: 1 });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("off");
    expect(result.current.view).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
    await expect(result.current.declare(ALL)).resolves.toBe(false);
    await expect(result.current.revoke()).resolves.toBe(false);
    result.current.reload();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does nothing without a workspace", () => {
    const { result } = mount({ ...BASE, workspacePath: null });
    expect(result.current.status).toBe("off");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(["gate-closed", "workspace-mismatch"])(
    "is hidden when the read is refused with %s, and stays quiet",
    async (code) => {
      invokeMock.mockRejectedValue(refusal(code));
      const { result, rerender } = mount();
      await waitFor(() => expect(result.current.status).toBe("hidden"));
      expect(result.current.view).toBeNull();
      expect(result.current.canDeclare).toBe(false);
      rerender({ ...BASE, version: 2 });
      window.dispatchEvent(new Event("focus"));
      result.current.reload();
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls(STATE)).toHaveLength(1);
    },
  );

  it("is hidden when the caller is not admitted", async () => {
    invokeMock.mockRejectedValue(
      new Error("D2A_EGRESS_DENIED: caller identity is missing"),
    );
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("hidden"));
  });

  it("is retried for the next Scene after a hidden one", async () => {
    invokeMock.mockRejectedValueOnce(refusal("gate-closed"));
    invokeMock.mockResolvedValue(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("hidden"));
    rerender({ ...BASE, sceneId: "scene-2" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls(STATE)).toHaveLength(2);
  });
});

describe("states", () => {
  it("is loading, then ready with Native's answer", async () => {
    const read = deferred<unknown>();
    invokeMock.mockReturnValue(read.promise);
    const { result } = mount();
    expect(result.current.status).toBe("loading");
    expect(result.current.view).toBeNull();
    await act(async () => read.resolve(declaredWire(true)));
    expect(result.current.status).toBe("ready");
    expect(result.current.view?.state).toMatchObject({
      kind: "declared",
      effective: true,
    });
    expect(result.current.canRevoke).toBe(true);
    expect(result.current.canDeclare).toBe(true);
  });

  it("shows nothing as effective while loading again, or after a failed read", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const next = deferred<unknown>();
    invokeMock.mockReturnValueOnce(next.promise);
    rerender({ ...BASE, version: 2 });
    expect(result.current.status).toBe("loading");
    expect(result.current.view).toBeNull();
    expect(result.current.canDeclare).toBe(false);
    expect(result.current.canRevoke).toBe(false);
    await act(async () => next.reject(refusal("internal")));
    expect(result.current.status).toBe("unknown");
    expect(result.current.failure).toBe("internal");
    expect(result.current.view).toBeNull();
    expect(result.current.canRevoke).toBe(false);
  });

  it("allows a manual reload after an unknown read", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom /home/x"));
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("unknown"));
    expect(result.current.failure).toBe("unknown-refusal");
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.status).toBe("ready"));
  });

  it("a blocker or an unusable answer leaves declaring off", async () => {
    invokeMock.mockResolvedValueOnce(noneWire("scene-archived"));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.canDeclare).toBe(false);
    await expect(result.current.declare(ALL)).resolves.toBe(false);
    invokeMock.mockResolvedValueOnce({
      occ: { scopeVersion: 3, scopeToken: "st" },
      declarationToken: null,
      state: { kind: "unavailable", reason: "half-state", blocker: null },
    });
    rerender({ ...BASE, version: 2 });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.canDeclare).toBe(false);
    expect(calls(DECLARE)).toHaveLength(0);
  });

  it("a restart-required read disables declare and revoke, and quiets automatic reads", async () => {
    invokeMock.mockRejectedValue(refusal("restart-required"));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("restart-required"));
    expect(result.current.canDeclare).toBe(false);
    expect(result.current.canRevoke).toBe(false);
    await expect(result.current.declare(ALL)).resolves.toBe(false);
    await expect(result.current.revoke()).resolves.toBe(false);
    rerender({ ...BASE, version: 2 });
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls(STATE)).toHaveLength(1);
    expect(calls(DECLARE)).toHaveLength(0);
    // A manual reload still asks (a restart is the only way out).
    act(() => result.current.reload());
    await waitFor(() => expect(calls(STATE)).toHaveLength(2));
  });

  it("notes when a declaration that was effective stops being so", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.becameInvalid).toBe(false);
    invokeMock.mockResolvedValueOnce(declaredWire(false, ["content"]));
    rerender({ ...BASE, version: 2 });
    await waitFor(() => expect(result.current.becameInvalid).toBe(true));
    invokeMock.mockResolvedValueOnce(declaredWire(false, ["content"]));
    rerender({ ...BASE, version: 3 });
    await waitFor(() => expect(calls(STATE)).toHaveLength(3));
    await waitFor(() => expect(result.current.becameInvalid).toBe(false));
  });
});

describe("late answers", () => {
  it("drops an answer that arrives after a Scene switch", async () => {
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    invokeMock.mockResolvedValueOnce(declaredWire(false, ["scope"], "dt-b"));
    const { result, rerender } = mount();
    rerender({ ...BASE, sceneId: "scene-2" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => first.resolve(declaredWire(true, [], "dt-a")));
    expect(result.current.view?.declarationToken).toBe("dt-b");
    expect(result.current.view?.state).toMatchObject({ effective: false });
  });

  it("drops an answer that arrives after a workspace switch", async () => {
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result, rerender } = mount();
    rerender({ ...BASE, workspacePath: "/other" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => first.resolve(declaredWire(true)));
    expect(result.current.view?.state.kind).toBe("none");
  });

  it("does not show another Scene's state for even one render", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    invokeMock.mockReturnValue(new Promise(() => {}));
    rerender({ ...BASE, sceneId: "scene-2" });
    expect(result.current.view).toBeNull();
    expect(result.current.status).toBe("loading");
  });

  it("drops an answer that arrives after unmount", async () => {
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = mount();
    unmount();
    await act(async () => first.resolve(noneWire()));
    expect(errors).not.toHaveBeenCalled();
    expect(calls(STATE)).toHaveLength(1);
  });

  it("drops a declare answer that arrives after a Scene switch, without a re-read for it", async () => {
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const declare = deferred<unknown>();
    invokeMock.mockReturnValueOnce(declare.promise);
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.declare(ALL);
    });
    invokeMock.mockResolvedValueOnce(noneWire());
    rerender({ ...BASE, sceneId: "scene-2" });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const readsBefore = calls(STATE).length;
    await act(async () => {
      declare.resolve({ outcome: "declared" });
      await pending;
    });
    expect(calls(STATE)).toHaveLength(readsBefore);
    expect(result.current.outcome).toBeNull();
  });
});

describe("operations", () => {
  async function ready(wire: unknown) {
    invokeMock.mockResolvedValueOnce(wire);
    const hook = mount();
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    return hook;
  }

  it("declares with the OCC and token of the same snapshot, then re-reads", async () => {
    const { result } = await ready(declaredWire(false, ["content"], "dt-1"));
    invokeMock.mockResolvedValueOnce({ outcome: "declared" });
    invokeMock.mockResolvedValueOnce(declaredWire(true, [], "dt-2"));
    await act(async () => {
      await result.current.declare(ALL);
    });
    const payload = (
      calls(DECLARE)[0][1] as {
        payload: { expected: unknown; requestId: string };
      }
    ).payload;
    expect(payload.expected).toEqual({
      scopeVersion: 3,
      scopeToken: "st",
      declarationToken: "dt-1",
    });
    expect(calls(STATE)).toHaveLength(2);
    expect(result.current.outcome).toEqual({ kind: "declared" });
    expect(result.current.view?.declarationToken).toBe("dt-2");
    expect(result.current.busy).toBeNull();
  });

  it("does not start a declaration until every axis is confirmed", async () => {
    const { result } = await ready(noneWire());
    await expect(
      result.current.declare({ ...ALL, phase: false }),
    ).resolves.toBe(false);
    expect(calls(DECLARE)).toHaveLength(0);
  });

  it("re-reads after a refused declaration, and explains it", async () => {
    const { result } = await ready(noneWire());
    invokeMock.mockRejectedValueOnce(new Error("MAIN_GRANT_CANCELLED"));
    invokeMock.mockResolvedValueOnce(noneWire());
    await act(async () => {
      await result.current.declare(ALL);
    });
    expect(result.current.outcome).toEqual({
      kind: "declare-refused",
      code: "grant-cancelled",
    });
    expect(calls(STATE)).toHaveLength(2);
    expect(result.current.status).toBe("ready");
  });

  it("re-reads after every revoke outcome", async () => {
    for (const outcome of [
      "revoked",
      "no-declaration",
      "declaration-changed",
    ]) {
      invokeMock.mockReset();
      const { result, unmount } = await ready(declaredWire(true));
      invokeMock.mockResolvedValueOnce({ outcome });
      invokeMock.mockResolvedValueOnce(noneWire());
      await act(async () => {
        await result.current.revoke();
      });
      expect(result.current.outcome).toEqual({ kind: outcome });
      expect(calls(STATE)).toHaveLength(2);
      expect(result.current.view?.state.kind).toBe("none");
      unmount();
    }
  });

  it("re-reads once and tells the author after state-changed and declaration-changed", async () => {
    const { result } = await ready(noneWire());
    invokeMock.mockRejectedValueOnce(refusal("state-changed"));
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    await act(async () => {
      await result.current.declare(ALL);
    });
    expect(result.current.outcome).toEqual({
      kind: "declare-refused",
      code: "state-changed",
    });
    expect(calls(STATE)).toHaveLength(2);
    invokeMock.mockResolvedValueOnce({ outcome: "declaration-changed" });
    invokeMock.mockResolvedValueOnce(declaredWire(false, ["scope"], "dt-2"));
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.outcome).toEqual({ kind: "declaration-changed" });
    expect(calls(STATE)).toHaveLength(3);
  });

  it("gives every operation a fresh requestId", async () => {
    const { result } = await ready(noneWire());
    invokeMock.mockRejectedValueOnce(refusal("state-changed"));
    invokeMock.mockResolvedValueOnce(noneWire());
    await act(async () => {
      await result.current.declare(ALL);
    });
    invokeMock.mockRejectedValueOnce(refusal("state-changed"));
    invokeMock.mockResolvedValueOnce(noneWire());
    await act(async () => {
      await result.current.declare(ALL);
    });
    const ids = calls(DECLARE).map(
      (call) =>
        (call[1] as { payload: { requestId: string } }).payload.requestId,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("runs no operation twice at once (a double click)", async () => {
    const { result } = await ready(noneWire());
    const declare = deferred<unknown>();
    invokeMock.mockReturnValueOnce(declare.promise);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    let third!: Promise<boolean>;
    act(() => {
      first = result.current.declare(ALL);
      second = result.current.declare(ALL);
      third = result.current.revoke();
    });
    expect(result.current.busy).toBe("declare");
    expect(result.current.canDeclare).toBe(false);
    expect(result.current.canRevoke).toBe(false);
    invokeMock.mockResolvedValueOnce(noneWire());
    await act(async () => {
      declare.resolve({ outcome: "declared" });
      await first;
    });
    await expect(second).resolves.toBe(false);
    await expect(third).resolves.toBe(false);
    expect(calls(DECLARE)).toHaveLength(1);
    expect(calls(REVOKE)).toHaveLength(0);
  });

  it("does not start an operation while a read is in flight", async () => {
    const { result, rerender } = await ready(noneWire());
    const read = deferred<unknown>();
    invokeMock.mockReturnValueOnce(read.promise);
    rerender({ ...BASE, version: 2 });
    await expect(result.current.declare(ALL)).resolves.toBe(false);
    await act(async () => read.resolve(noneWire()));
    expect(calls(DECLARE)).toHaveLength(0);
  });

  it("turns an unexpected throw into an unknown refusal and still re-reads", async () => {
    const { result } = await ready(declaredWire(true));
    invokeMock.mockImplementationOnce(() => {
      throw "not an error";
    });
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.outcome).toMatchObject({ kind: "revoke-refused" });
    expect(result.current.busy).toBeNull();
    expect(calls(STATE)).toHaveLength(2);
  });
});

describe("re-reads", () => {
  it.each([
    ["version", { version: 2 }],
    ["updatedAt", { updatedAt: "2026-10-23T00:00:01Z" }],
    ["title", { title: "Renamed" }],
    ["refreshKey", { refreshKey: 1 }],
  ])("re-reads when the %s changes", async (_name, change) => {
    invokeMock.mockResolvedValue(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls(STATE)).toHaveLength(1);
    rerender({ ...BASE });
    expect(calls(STATE)).toHaveLength(1);
    rerender({ ...BASE, ...change });
    await waitFor(() => expect(calls(STATE)).toHaveLength(2));
  });

  it("re-reads when the window gets focus again", async () => {
    invokeMock.mockResolvedValue(noneWire());
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(calls(STATE)).toHaveLength(2));
  });

  it("folds the triggers that arrive during a read into one more read", async () => {
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    invokeMock.mockResolvedValue(noneWire());
    const { result, rerender } = mount();
    rerender({ ...BASE, version: 2 });
    rerender({ ...BASE, version: 3 });
    rerender({ ...BASE, version: 4, title: "T" });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(calls(STATE)).toHaveLength(1);
    await act(async () => first.resolve(noneWire()));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls(STATE)).toHaveLength(2);
  });

  it("folds the triggers that arrive during an operation into the re-read after it", async () => {
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const declare = deferred<unknown>();
    invokeMock.mockReturnValueOnce(declare.promise);
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.declare(ALL);
    });
    rerender({ ...BASE, version: 2 });
    rerender({ ...BASE, version: 3 });
    expect(calls(STATE)).toHaveLength(1);
    invokeMock.mockResolvedValue(noneWire());
    await act(async () => {
      declare.resolve({ outcome: "declared" });
      await pending;
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls(STATE)).toHaveLength(2);
  });
});

describe("what the hook never does", () => {
  it("writes no storage, logs nothing and never shows a token or a raw message", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    invokeMock.mockRejectedValueOnce(new Error("failed at /home/author/x.db"));
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    await act(async () => {
      await result.current.revoke();
    });
    expect(result.current.outcome).toEqual({
      kind: "revoke-refused",
      code: "unknown-refusal",
    });
    expect(JSON.stringify(result.current.outcome)).not.toContain("/home");
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of [log, warn, error, debug]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
