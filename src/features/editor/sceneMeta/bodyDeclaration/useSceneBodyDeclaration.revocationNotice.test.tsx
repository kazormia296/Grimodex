// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, notify } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("./bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => true,
}));
vi.mock("@/features/related-scenes/nir1GraphOnlyRevocation", () => ({
  notifyNir1GraphOnlyRevoked: notify,
}));
import { useSceneBodyDeclaration } from "./useSceneBodyDeclaration";

// DR-CP3B-9 (D8-b): a successful revoke tells Related Scenes the Scene ID only.
const declared = {
  occ: { scopeVersion: 3, scopeToken: "st" },
  declarationToken: "dt",
  state: { kind: "declared", effective: true, expiredBy: [], blocker: null },
};
const none = {
  occ: { scopeVersion: 3, scopeToken: "st" },
  declarationToken: null,
  state: { kind: "none", blocker: null },
};

async function ready() {
  invokeMock.mockResolvedValueOnce(declared);
  const hook = renderHook(() =>
    useSceneBodyDeclaration({
      workspacePath: "/workspace",
      projectId: "project-1",
      sceneId: "scene-1",
      version: 1,
      updatedAt: "2026-10-23T00:00:00Z",
      title: "Scene",
      refreshKey: 0,
    }),
  );
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

beforeEach(() => {
  invokeMock.mockReset();
  notify.mockReset();
});

describe("the revoke notice to Related Scenes", () => {
  it("notifies with the Scene ID after a revoke Native accepted", async () => {
    const { result } = await ready();
    invokeMock.mockResolvedValueOnce({ outcome: "revoked" });
    invokeMock.mockResolvedValueOnce(none);
    await act(async () => {
      await result.current.revoke();
    });
    expect(notify).toHaveBeenCalledExactlyOnceWith("scene-1");
  });

  it("does not notify after a refused revoke", async () => {
    const { result } = await ready();
    invokeMock.mockRejectedValueOnce(
      new Error("NEX_BODY_DECLARATION_REFUSED:state-changed"),
    );
    invokeMock.mockResolvedValueOnce(declared);
    await act(async () => {
      await result.current.revoke();
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
