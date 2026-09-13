// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneScopeRegistryEditor } from "./SceneScopeRegistryEditor";
import type { Registry } from "./sceneScopeTypes";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const registry: Registry = {
  registryVersion: "narrative-scene-scope-registry/1",
  timelineRefs: ["timeline:main"],
  worldlineRefs: [],
  narrativeLayerRefs: [],
};

describe("SceneScopeRegistryEditor request epochs", () => {
  it("does not publish a deferred save after scene navigation", async () => {
    const pending = deferred<{
      registry: Registry;
      registryRevision: number;
      registrySourceToken: string;
      registryUpdatedAt: string;
    }>();
    const onSaved = vi.fn();
    invokeMock.mockReset().mockReturnValueOnce(pending.promise);
    const { rerender } = render(
      <SceneScopeRegistryEditor
        projectId="project-1"
        sceneId="scene-a"
        workspacePath="/workspace"
        registry={registry}
        registryRevision={1}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    rerender(
      <SceneScopeRegistryEditor
        projectId="project-1"
        sceneId="scene-b"
        workspacePath="/workspace"
        registry={registry}
        registryRevision={1}
        onSaved={onSaved}
      />,
    );
    await act(async () =>
      pending.resolve({
        registry,
        registryRevision: 2,
        registrySourceToken: "stale",
        registryUpdatedAt: "2026-09-13T00:01:00.000Z",
      }),
    );
    expect(onSaved).not.toHaveBeenCalled();
  });
});
