// @vitest-environment happy-dom
import { Component } from "react";
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { ScopeRead } from "./sceneScopeTypes";

// DR-PUBG-40-1 (DR-CB3-35 (1)): a render or effect error of the declaration
// section is caught by the boundary around it. The section is the mocked
// `./bodyDeclaration/SceneBodyDeclarationSection`, replaced per test.
const { behavior, invokeMock, logged } = vi.hoisted(() => ({
  behavior: { current: "ok" as "ok" | "render" | "effect" },
  invokeMock: vi.fn(),
  logged: [] as Array<{ tag: string; message: string }>,
}));
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
vi.mock("./SceneScopeFields", () => ({ SceneScopeFields: () => null }));
vi.mock("./SceneScopePrincipals", () => ({ SceneScopePrincipals: () => null }));
vi.mock("./SceneScopeRegistryEditor", () => ({
  SceneScopeRegistryEditor: () => null,
}));
// The constant is turned on only inside this test (DR-PUBG-40-1). The real
// constant stays false.
vi.mock("./bodyDeclaration/bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => true,
}));
vi.mock("@/lib/debugLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/debugLog")>()),
  debugLog: {
    error: (tag: string, message: string) => logged.push({ tag, message }),
  },
}));
vi.mock("./bodyDeclaration/SceneBodyDeclarationSection", async () => {
  const { useEffect } = await import("react");
  return {
    SceneBodyDeclarationSection: function Section() {
      if (behavior.current === "render") throw new Error("render failed");
      useEffect(() => {
        if (behavior.current === "effect") throw new Error("effect failed");
      }, []);
      return <div data-testid="scene-body-declaration" />;
    },
  };
});

import { SceneScopeEditor } from "./SceneScopeEditor";

function scope(version: number): ScopeRead {
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
      sceneId: "scene-1",
      sceneIncarnationId: "incarnation-1",
      compatibilityMarker: "explicit",
      queryIdentity: {
        timeline: { kind: "any" },
        worldline: { kind: "any" },
        narrativeLayer: { kind: "any" },
      },
      materialConstraint: {
        timeline: { kind: "any" },
        worldline: { kind: "any" },
        narrativeLayer: { kind: "any" },
      },
      knowledgeHolder: { kind: "reader" },
      audience: { kind: "reader" },
      version,
      sourceToken: `token-${version}`,
      updatedAt: "2026-09-13T00:00:00.000Z",
    },
  };
}

const node = {
  id: "scene-1",
  nodeType: "scene",
  projectId: "project-1",
  title: "Scene",
} as TreeNodeData;

// Stands in for the boundary above SceneScopeEditor (the app root's
// ErrorBoundary): it must never be reached.
class OuterBoundary extends Component<
  { children: ReactNode },
  { reached: boolean }
> {
  state = { reached: false };
  static getDerivedStateFromError() {
    return { reached: true };
  }
  render() {
    return this.state.reached ? (
      <div data-testid="outer-boundary-reached" />
    ) : (
      this.props.children
    );
  }
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  behavior.current = "ok";
  logged.length = 0;
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command === "narrative_scene_scope_read") return scope(1);
    throw new Error(`unexpected command ${command}`);
  });
  // React logs a caught error to the console; the assertions below read it too.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderEditor() {
  const view = render(
    <OuterBoundary>
      <SceneScopeEditor node={node} />
    </OuterBoundary>,
  );
  await act(async () => {});
  await act(async () => {});
  return view;
}

describe("SceneScopeEditor declaration section error boundary", () => {
  it("mounts the section when nothing fails", async () => {
    await renderEditor();
    expect(screen.getByTestId("scene-body-declaration")).toBeTruthy();
    expect(logged).toEqual([]);
  });

  for (const failure of ["render", "effect"] as const) {
    it(`hides only the section and logs when it throws in its ${failure}`, async () => {
      behavior.current = failure;
      await renderEditor();
      expect(screen.queryByTestId("outer-boundary-reached")).toBeNull();
      expect(screen.queryByTestId("scene-body-declaration")).toBeNull();
      const save = screen.getByTestId("scene-scope-binding-save");
      expect(save).toBeEnabled();
      expect(screen.getByTestId("scene-scope-editor").contains(save)).toBe(
        true,
      );
      expect(logged).toEqual([
        { tag: "SceneBodyDeclaration", message: "declaration section failed" },
      ]);
      expect(consoleError).toHaveBeenCalled();
    });
  }
});
