// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke, isElectron: () => true }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { SceneScopeDefaultSection } from "./SceneScopeDefaultSection";

const MAIN = {
  timeline: { kind: "exact", ref: "timeline:main" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};
const NONE = {
  projectId: "project-1",
  default: { state: "none" },
  version: 0,
  sourceToken: null,
  updatedAt: null,
};

function route(handlers: Record<string, (args: never) => unknown>) {
  h.invoke.mockImplementation(async (command: string, args: never) => {
    const handler = handlers[command];
    if (!handler) throw new Error(`unexpected ${command}`);
    return handler(args);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useTreeStore.setState({ nodes: [] } as never);
});
afterEach(cleanup);

function renderSection() {
  render(
    <SceneScopeDefaultSection
      workspacePath="/workspace"
      projectId="project-1"
    />,
  );
}

describe("設定 > プロジェクトの Scope の既定（DR-SDEF-29）", () => {
  it("saves the main line with baseVersion 0 through the typed command only", async () => {
    route({
      narrative_scope_project_default_read: () => NONE,
      narrative_scope_project_default_update: () => ({
        ...NONE,
        default: {
          state: "set",
          queryIdentity: MAIN,
          materialConstraint: MAIN,
        },
        version: 1,
      }),
    });
    renderSection();
    fireEvent.change(await screen.findByTestId("scene-scope-default-mode"), {
      target: { value: "set" },
    });
    fireEvent.click(screen.getByTestId("scene-scope-default-save"));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "narrative_scope_project_default_update",
        expect.objectContaining({
          expectedWorkspacePath: "/workspace",
          payload: expect.objectContaining({
            projectId: "project-1",
            baseVersion: 0,
            default: {
              state: "set",
              queryIdentity: MAIN,
              materialConstraint: MAIN,
            },
          }),
        }),
      ),
    );
    // Choosing the default writes nothing else (R17).
    expect(
      h.invoke.mock.calls.some(
        ([command]) => command === "narrative_scene_scope_update",
      ),
    ).toBe(false);
  });

  it("stops applying while the form differs from the saved default, and while there is none (PR-2 review P2-1)", async () => {
    route({
      narrative_scope_project_default_read: () => ({
        ...NONE,
        default: {
          state: "set",
          queryIdentity: MAIN,
          materialConstraint: MAIN,
        },
        version: 2,
      }),
    });
    renderSection();
    const apply = (await screen.findByTestId(
      "scope-default-apply-unset",
    )) as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    fireEvent.change(screen.getByTestId("scene-scope-default-mode"), {
      target: { value: "none" },
    });
    expect(apply.disabled).toBe(true);
    expect(screen.getByTestId("scene-scope-default-unsaved")).toBeTruthy();
    fireEvent.change(screen.getByTestId("scene-scope-default-mode"), {
      target: { value: "set" },
    });
    expect(apply.disabled).toBe(false);
    cleanup();

    route({ narrative_scope_project_default_read: () => NONE });
    renderSection();
    expect(
      (
        (await screen.findByTestId(
          "scope-default-apply-unset",
        )) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("explains a project without a vocabulary instead of the raw error (PR-1 P3-2)", async () => {
    route({
      narrative_scope_project_default_read: () => NONE,
      narrative_scope_project_default_update: () => {
        throw new Error(
          "NEX_SCENE_SCOPE_AUTHORITY_UNAVAILABLE: scope registry is missing",
        );
      },
    });
    renderSection();
    fireEvent.change(await screen.findByTestId("scene-scope-default-mode"), {
      target: { value: "set" },
    });
    fireEvent.click(screen.getByTestId("scene-scope-default-save"));
    expect(
      (await screen.findByTestId("scene-scope-default-notice")).textContent,
    ).toBe("settings.project.sceneScopeNoVocabulary");
  });

  it("shows a broken default row as an error and offers no choice (PR-1 P3-1)", async () => {
    route({
      narrative_scope_project_default_read: () => {
        throw new Error(
          "NEX_SCENE_SCOPE_DEFAULT_INVALID: scope default source token does not match its state",
        );
      },
    });
    renderSection();
    expect(
      await screen.findByTestId("scene-scope-default-invalid"),
    ).toBeTruthy();
    expect(screen.queryByTestId("scene-scope-default-mode")).toBeNull();
    expect(screen.queryByTestId("scope-default-apply")).toBeNull();
  });

  it("warns before a value outside the vocabulary (R19) using one Scene's registry", async () => {
    useTreeStore.setState({
      nodes: [{ id: "scene-1", projectId: "project-1", nodeType: "scene" }],
    } as never);
    route({
      narrative_scope_project_default_read: () => ({
        ...NONE,
        default: {
          state: "set",
          queryIdentity: {
            ...MAIN,
            timeline: { kind: "exact", ref: "timeline:old" },
          },
          materialConstraint: {
            ...MAIN,
            timeline: { kind: "exact", ref: "timeline:old" },
          },
        },
        version: 3,
      }),
      narrative_scene_scope_read: () => ({
        registry: {
          registryVersion: "narrative-scene-scope-registry/1",
          timelineRefs: ["timeline:main"],
          worldlineRefs: ["worldline:prime"],
          narrativeLayerRefs: ["layer:manuscript"],
        },
      }),
    });
    renderSection();
    expect(
      await screen.findByTestId("scene-scope-default-registry-warning"),
    ).toBeTruthy();
    // Saving would be refused (REF_UNREGISTERED): the save waits for the
    // vocabulary.
    expect(
      (screen.getByTestId("scene-scope-default-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByTestId("scene-scope-default-timeline"), {
      target: { value: "timeline:main" },
    });
    expect(
      screen.queryByTestId("scene-scope-default-registry-warning"),
    ).toBeNull();
  });
});
