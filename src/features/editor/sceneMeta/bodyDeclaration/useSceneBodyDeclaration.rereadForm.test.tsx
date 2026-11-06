// @vitest-environment happy-dom
// DR-PUBG-39-1 / DR-PUBG-39-2: what the hook says about the first read and
// about the form while the same Scene is read again.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("./bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => true,
}));

import {
  useSceneBodyDeclaration,
  type UseSceneBodyDeclarationInput,
} from "./useSceneBodyDeclaration";

const noneWire = (blocker: string | null = null) => ({
  occ: blocker === null ? { scopeVersion: 3, scopeToken: "st" } : null,
  declarationToken: null,
  state: { kind: "none", blocker },
});
const declaredWire = (effective: boolean, expiredBy: string[] = []) => ({
  occ: { scopeVersion: 3, scopeToken: "st" },
  declarationToken: "dt",
  state: { kind: "declared", effective, expiredBy, blocker: null },
});
const refusal = (code: string) =>
  new Error(`NEX_BODY_DECLARATION_REFUSED:${code}`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BASE: UseSceneBodyDeclarationInput = {
  workspacePath: "/workspace",
  projectId: "project-1",
  sceneId: "scene-1",
  version: 1,
  updatedAt: "2026-10-23T00:00:00Z",
  title: "Scene",
  refreshKey: 0,
};
const mount = (initial = BASE) =>
  renderHook(
    (props: UseSceneBodyDeclarationInput) => useSceneBodyDeclaration(props),
    { initialProps: initial },
  );

beforeEach(() => {
  invokeMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("answered (DR-PUBG-39-2)", () => {
  it("is false until the first read is answered with something that is shown", async () => {
    const read = deferred<unknown>();
    invokeMock.mockReturnValueOnce(read.promise);
    const { result } = mount();
    expect(result.current.status).toBe("loading");
    expect(result.current.answered).toBe(false);
    await act(async () => read.resolve(noneWire()));
    expect(result.current.answered).toBe(true);
  });

  it.each([
    ["store-failure", "unknown"],
    ["restart-required", "restart-required"],
  ])("is true for a %s answer", async (code, status) => {
    invokeMock.mockRejectedValueOnce(refusal(code));
    const { result } = mount();
    await waitFor(() => expect(result.current.status).toBe(status));
    expect(result.current.answered).toBe(true);
  });

  it("stays false for a closed gate and for a Scene that is gone", async () => {
    invokeMock.mockRejectedValueOnce(refusal("gate-closed"));
    const closed = mount();
    await waitFor(() => expect(closed.result.current.status).toBe("hidden"));
    expect(closed.result.current.answered).toBe(false);

    invokeMock.mockResolvedValueOnce(noneWire("scene-not-found"));
    const gone = mount({ ...BASE, sceneId: "scene-9" });
    await waitFor(() => expect(gone.result.current.status).toBe("hidden"));
    expect(gone.result.current.answered).toBe(false);
  });

  it("stays true through a re-read of the same Scene, and starts again for another", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const next = deferred<unknown>();
    invokeMock.mockReturnValueOnce(next.promise);
    rerender({ ...BASE, version: 2 });
    expect(result.current.status).toBe("loading");
    expect(result.current.answered).toBe(true);
    await act(async () => next.resolve(declaredWire(true)));

    const other = deferred<unknown>();
    invokeMock.mockReturnValueOnce(other.promise);
    rerender({ ...BASE, sceneId: "scene-2" });
    expect(result.current.status).toBe("loading");
    expect(result.current.answered).toBe(false);
  });
});

describe("retainedForm (DR-PUBG-39-1)", () => {
  it("keeps the shape of a draft form through a re-read, with nothing effective", async () => {
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.retainedForm).toBeNull();
    const next = deferred<unknown>();
    invokeMock.mockReturnValueOnce(next.promise);
    rerender({ ...BASE, version: 2 });
    expect(result.current.status).toBe("loading");
    expect(result.current.retainedForm).toEqual({
      expired: false,
      couldDeclare: true,
    });
    expect(result.current.view).toBeNull();
    expect(result.current.canDeclare).toBe(false);
    expect(result.current.canRevoke).toBe(false);
    await act(async () => next.resolve(noneWire()));
    expect(result.current.retainedForm).toBeNull();
  });

  it("keeps an expired (not effective) declaration's form, and a blocked draft as not usable", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(false, ["content"]));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    rerender({ ...BASE, version: 2 });
    expect(result.current.retainedForm).toEqual({
      expired: true,
      couldDeclare: true,
    });

    invokeMock.mockResolvedValueOnce(noneWire("veto-limit"));
    const blocked = mount({ ...BASE, sceneId: "scene-2" });
    await waitFor(() => expect(blocked.result.current.status).toBe("ready"));
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    blocked.rerender({ ...BASE, sceneId: "scene-2", version: 2 });
    expect(blocked.result.current.retainedForm).toEqual({
      expired: false,
      couldDeclare: false,
    });
  });

  it("keeps no form for an effective declaration, a failed read or another Scene", async () => {
    invokeMock.mockResolvedValueOnce(declaredWire(true));
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    rerender({ ...BASE, version: 2 });
    expect(result.current.retainedForm).toBeNull();

    invokeMock.mockResolvedValueOnce(noneWire());
    const fresh = mount({ ...BASE, sceneId: "scene-2" });
    await waitFor(() => expect(fresh.result.current.status).toBe("ready"));
    invokeMock.mockReturnValueOnce(new Promise(() => {}));
    fresh.rerender({ ...BASE, sceneId: "scene-3" });
    expect(fresh.result.current.status).toBe("loading");
    expect(fresh.result.current.retainedForm).toBeNull();
  });

  it("carries the form through a re-read that was queued behind another", async () => {
    invokeMock.mockResolvedValueOnce(noneWire());
    const { result, rerender } = mount();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const first = deferred<unknown>();
    invokeMock.mockReturnValueOnce(first.promise);
    rerender({ ...BASE, version: 2 });
    const second = deferred<unknown>();
    invokeMock.mockReturnValueOnce(second.promise);
    rerender({ ...BASE, version: 3 });
    await act(async () => first.resolve(noneWire()));
    // The queued read runs after the first ends; the form never vanishes.
    expect(result.current.retainedForm).not.toBeNull();
    await act(async () => second.resolve(noneWire()));
    expect(result.current.status).toBe("ready");
  });
});
