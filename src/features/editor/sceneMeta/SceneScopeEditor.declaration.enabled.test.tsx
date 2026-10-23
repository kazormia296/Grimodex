// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SceneScopeEditor } from "./SceneScopeEditor";
import type { ScopeRead } from "./sceneScopeTypes";

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
vi.mock("./SceneScopeFields", () => ({ SceneScopeFields: () => null }));
vi.mock("./SceneScopePrincipals", () => ({ SceneScopePrincipals: () => null }));
vi.mock("./SceneScopeRegistryEditor", () => ({
  SceneScopeRegistryEditor: () => null,
}));
vi.mock("./bodyDeclaration/bodyDeclarationAvailability", () => ({
  BODY_DECLARATION_UI_ENABLED: false,
  isBodyDeclarationUiEnabled: () => true,
}));

const STATE = "narrative_scene_body_declaration_state";

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

const stateCalls = () =>
  invokeMock.mock.calls.filter((call) => call[0] === STATE);

let bindingVersion = 1;

beforeEach(() => {
  bindingVersion = 1;
  invokeMock.mockReset().mockImplementation(async (command: string) => {
    if (command === "narrative_scene_scope_read") return scope(bindingVersion);
    if (command === "narrative_scene_scope_update") {
      bindingVersion += 1;
      const next = scope(bindingVersion);
      return { registry: next.registry, binding: next.binding };
    }
    if (command === STATE) {
      return {
        occ: { scopeVersion: bindingVersion, scopeToken: "t" },
        declarationToken: "d",
        state: {
          kind: "declared",
          effective: bindingVersion === 1,
          expiredBy: bindingVersion === 1 ? [] : ["scope"],
          blocker: null,
        },
      };
    }
    throw new Error(`unexpected command ${command}`);
  });
});

describe("the body declaration panel in SceneScopeEditor when enabled", () => {
  it("mounts under the scope editor and reads again after A1 is saved", async () => {
    render(<SceneScopeEditor node={node} />);
    await waitFor(() =>
      expect(
        screen.getByTestId("scene-body-declaration").getAttribute("data-state"),
      ).toBe("effective"),
    );
    // The panel sits inside the scope editor, below the A1 controls.
    expect(
      screen
        .getByTestId("scene-scope-editor")
        .contains(screen.getByTestId("scene-body-declaration")),
    ).toBe(true);
    const before = stateCalls().length;
    await waitFor(() =>
      expect(screen.getByTestId("scene-scope-binding-save")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    await waitFor(() =>
      expect(
        screen.getByTestId("scene-body-declaration").getAttribute("data-state"),
      ).toBe("expired"),
    );
    expect(stateCalls().length).toBeGreaterThan(before);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("body-declaration-expiry-scope")).toBeVisible();
  });
});
