// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SceneScopeEditor } from "./SceneScopeEditor";
import type {
  Constraint,
  RegistryUpdate,
  ScopeRead,
  ScopeUpdate,
} from "./sceneScopeTypes";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  isElectron: () => true,
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (
    selector: (state: { activeWorkspacePath: string }) => unknown,
  ) => selector({ activeWorkspacePath: "/workspace" }),
}));

vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: (selector: (state: { entries: never[] }) => unknown) =>
    selector({ entries: [] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("./SceneScopeFields", () => ({
  SceneScopeFields: ({
    onAxisChange,
  }: {
    onAxisChange: (
      group: "queryIdentity" | "materialConstraint",
      axis: "timeline" | "worldline" | "narrativeLayer",
      value: Constraint,
    ) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="scene-scope-test-edit"
        onClick={() =>
          onAxisChange("queryIdentity", "timeline", {
            kind: "exact",
            ref: "timeline:local",
          })
        }
      >
        Edit
      </button>
      <button
        type="button"
        data-testid="scene-scope-test-edit-pending"
        onClick={() =>
          onAxisChange("queryIdentity", "timeline", {
            kind: "exact",
            ref: "timeline:blocked",
          })
        }
      >
        Attempt pending edit
      </button>
    </>
  ),
}));
vi.mock("./SceneScopePrincipals", () => ({ SceneScopePrincipals: () => null }));
vi.mock("./SceneScopeRegistryEditor", () => ({
  SceneScopeRegistryEditor: ({
    projectId,
    sceneId,
    workspacePath,
    registry,
    registryRevision,
    onSaved,
  }: {
    projectId: string;
    sceneId: string;
    workspacePath: string;
    registry: RegistryUpdate["registry"];
    registryRevision: number;
    onSaved: (update: RegistryUpdate) => void | Promise<void>;
  }) => (
    <div data-testid="scene-scope-registry-editor">
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(
            invokeMock("narrative_scene_scope_registry_update", {
              expectedWorkspacePath: workspacePath,
              payload: {
                projectId,
                sceneId,
                baseVersion: registryRevision,
                registry,
              },
            }),
          ).then(onSaved);
        }}
      >
        Save
      </button>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function node(id: string): TreeNodeData {
  return {
    id,
    nodeType: "scene",
    projectId: "project-1",
    title: id,
  } as TreeNodeData;
}

function scope(sceneId: string, version: number): ScopeRead {
  return {
    registry: {
      registryVersion: "narrative-scene-scope-registry/1",
      timelineRefs: [],
      worldlineRefs: [],
      narrativeLayerRefs: [],
    },
    registryRevision: 1,
    registrySourceToken: "registry-token",
    registryUpdatedAt: "2026-09-13T00:00:00.000Z",
    binding: {
      schemaVersion: 1,
      projectId: "project-1",
      sceneId,
      sceneIncarnationId: `incarnation-${sceneId}`,
      compatibilityMarker: "unknown",
      queryIdentity: {
        timeline: { kind: "unresolved", reason: "test" },
        worldline: { kind: "unresolved", reason: "test" },
        narrativeLayer: { kind: "unresolved", reason: "test" },
      },
      materialConstraint: {
        timeline: { kind: "any" },
        worldline: { kind: "any" },
        narrativeLayer: { kind: "any" },
      },
      knowledgeHolder: { kind: "reader" },
      audience: { kind: "reader" },
      version,
      sourceToken: `token-${sceneId}-${version}`,
      updatedAt: "2026-09-13T00:00:00.000Z",
    },
  };
}

describe("SceneScopeEditor request epochs", () => {
  it("ignores a deferred read from the scene selected before navigation", async () => {
    const first = deferred<ScopeRead>();
    const second = deferred<ScopeRead>();
    invokeMock
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { rerender } = render(<SceneScopeEditor node={node("scene-a")} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    rerender(<SceneScopeEditor node={node("scene-b")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve(scope("scene-a", 11)));
    expect(screen.getByTestId("scene-scope-editor").textContent).not.toContain(
      "v11",
    );
    await act(async () => second.resolve(scope("scene-b", 12)));
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-editor").textContent).toContain(
        "v12",
      ),
    );
  });

  it("ignores a deferred save response after navigation", async () => {
    const readA = deferred<ScopeRead>();
    const saveA = deferred<{
      registry: ScopeRead["registry"];
      binding: ScopeRead["binding"];
    }>();
    const readB = deferred<ScopeRead>();
    invokeMock
      .mockReset()
      .mockReturnValueOnce(readA.promise)
      .mockReturnValueOnce(saveA.promise)
      .mockReturnValueOnce(readB.promise);
    const { rerender } = render(<SceneScopeEditor node={node("scene-a")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await act(async () => readA.resolve(scope("scene-a", 1)));
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-binding-save")).toBeTruthy(),
    );
    fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    rerender(<SceneScopeEditor node={node("scene-b")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
    await act(async () => readB.resolve(scope("scene-b", 7)));
    await act(async () =>
      saveA.resolve({
        registry: scope("scene-a", 99).registry,
        binding: scope("scene-a", 99).binding,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-editor").textContent).toContain(
        "v7",
      ),
    );
    expect(screen.getByTestId("scene-scope-editor").textContent).not.toContain(
      "v99",
    );
  });

  it("rereads the binding after a registry save before the next update", async () => {
    const initialRead = deferred<ScopeRead>();
    const registrySave = deferred<ScopeRead>();
    const refreshedRead = deferred<ScopeRead>();
    const scopeSave = deferred<{
      registry: ScopeRead["registry"];
      binding: ScopeRead["binding"];
    }>();
    invokeMock
      .mockReset()
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(registrySave.promise)
      .mockReturnValueOnce(refreshedRead.promise)
      .mockReturnValueOnce(scopeSave.promise);
    render(<SceneScopeEditor node={node("scene-a")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await act(async () => initialRead.resolve(scope("scene-a", 1)));

    const registryEditor = screen.getByTestId("scene-scope-registry-editor");
    fireEvent.click(
      within(registryEditor).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    const registryResponse = scope("scene-a", 1);
    registryResponse.registryRevision = 2;
    registrySave.resolve(registryResponse);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));

    const refreshed = scope("scene-a", 9);
    refreshed.registryRevision = 2;
    await act(async () => refreshedRead.resolve(refreshed));
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-editor").textContent).toContain(
        "v9",
      ),
    );

    fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(4));
    expect(invokeMock.mock.calls[3][1].payload.baseVersion).toBe(9);
  });

  it("clears the stale writers when the registry synchronization read fails", async () => {
    const initialRead = deferred<ScopeRead>();
    const registrySave = deferred<ScopeRead>();
    const refreshFailure = deferred<ScopeRead>();
    invokeMock
      .mockReset()
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(registrySave.promise)
      .mockReturnValueOnce(refreshFailure.promise);
    render(<SceneScopeEditor node={node("scene-a")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await act(async () => initialRead.resolve(scope("scene-a", 1)));

    fireEvent.click(
      within(screen.getByTestId("scene-scope-registry-editor")).getByRole(
        "button",
        {
          name: "Save",
        },
      ),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    registrySave.resolve(scope("scene-a", 1));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
    await act(async () =>
      refreshFailure.reject(new Error("scope refresh failed")),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("scene-scope-binding-save")).toBeNull(),
    );
    expect(screen.getByText("scope refresh failed")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledTimes(3);
  });

  it("rebases an OCC conflict and saves the local draft without navigation", async () => {
    const initialRead = deferred<ScopeRead>();
    const staleSave = deferred<ScopeUpdate>();
    const recoveryRead = deferred<ScopeRead>();
    const retrySave = deferred<ScopeUpdate>();
    invokeMock
      .mockReset()
      .mockReturnValueOnce(initialRead.promise)
      .mockReturnValueOnce(staleSave.promise)
      .mockReturnValueOnce(recoveryRead.promise)
      .mockReturnValueOnce(retrySave.promise);
    render(<SceneScopeEditor node={node("scene-a")} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
    await act(async () => initialRead.resolve(scope("scene-a", 1)));

    fireEvent.click(screen.getByTestId("scene-scope-test-edit"));
    fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock.mock.calls[1][1].payload.baseVersion).toBe(1);
    staleSave.reject(
      new Error(
        "NEX_SCENE_SCOPE_VERSION_MISMATCH: expected base version 1, current is 2",
      ),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("scene-scope-controls")).toBeDisabled();
    expect(screen.getByTestId("scene-scope-test-edit-pending")).toBeDisabled();
    fireEvent.click(screen.getByTestId("scene-scope-test-edit-pending"));

    const recovered = scope("scene-a", 2);
    recovered.binding.materialConstraint.timeline = {
      kind: "exact",
      ref: "timeline:peer",
    };
    await act(async () => recoveryRead.resolve(recovered));
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-editor").textContent).toContain(
        "v2",
      ),
    );
    expect(screen.getByTestId("scene-scope-controls")).not.toBeDisabled();
    expect(
      screen.getByText(
        "Scene scope changed while you were editing. Review your draft and save again.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByTestId("scene-scope-conflict-fresh").textContent,
    ).toContain("material.timeline=timeline:peer");

    fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(4));
    expect(invokeMock.mock.calls[3][1].payload.baseVersion).toBe(2);
    expect(
      invokeMock.mock.calls[3][1].payload.scope.queryIdentity.timeline,
    ).toEqual({ kind: "exact", ref: "timeline:local" });
    expect(
      invokeMock.mock.calls[3][1].payload.scope.materialConstraint.timeline,
    ).toEqual({ kind: "any" });
    await act(async () =>
      retrySave.resolve({
        registry: recovered.registry,
        binding: {
          ...recovered.binding,
          version: 3,
          queryIdentity: {
            ...recovered.binding.queryIdentity,
            timeline: { kind: "exact", ref: "timeline:local" },
          },
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-editor").textContent).toContain(
        "v3",
      ),
    );
  });
});
