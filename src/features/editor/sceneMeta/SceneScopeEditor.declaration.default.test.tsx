// @vitest-environment happy-dom
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SceneScopeEditor } from "./SceneScopeEditor";

const { invokeMock, sectionModuleLoaded } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sectionModuleLoaded: { value: false },
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
// No mock of the availability module: this is the product default.
// The section is a lazy chunk (DR-CB3-35). This pass-through mock only records
// whether the module was ever requested; with the default it must not be.
vi.mock(
  "./bodyDeclaration/SceneBodyDeclarationSection",
  async (importOriginal) => {
    sectionModuleLoaded.value = true;
    return importOriginal();
  },
);

describe("the body declaration panel in SceneScopeEditor with the product default", () => {
  it("is not mounted and no declaration command is invoked", async () => {
    invokeMock.mockReset().mockRejectedValue(new Error("not under test"));
    render(
      <SceneScopeEditor
        node={
          {
            id: "scene-1",
            nodeType: "scene",
            projectId: "project-1",
            title: "Scene",
          } as TreeNodeData
        }
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(screen.getByTestId("scene-scope-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("scene-body-declaration")).toBeNull();
    const commands = invokeMock.mock.calls.map((call) => String(call[0]));
    expect(commands.filter((c) => c.includes("body_declaration"))).toEqual([]);
    expect(sectionModuleLoaded.value).toBe(false);
  });
});
