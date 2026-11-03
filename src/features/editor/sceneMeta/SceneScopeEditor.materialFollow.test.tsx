// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { SceneScopeEditor } from "./SceneScopeEditor";
import type { Binding, ScopeRead } from "./sceneScopeTypes";

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
vi.mock("./SceneScopePrincipals", () => ({ SceneScopePrincipals: () => null }));
vi.mock("./SceneScopeRegistryEditor", () => ({
  SceneScopeRegistryEditor: () => null,
}));
vi.mock("./SceneScopeDefaultActions", () => ({
  SceneScopeDefaultActions: () => null,
}));

const MAIN = { kind: "exact", ref: "timeline:main" } as const;
const FLASHBACK = { kind: "exact", ref: "timeline:flashback" } as const;

function read(binding: Partial<Binding>): ScopeRead {
  return {
    registry: {
      registryVersion: "narrative-scene-scope-registry/1",
      timelineRefs: ["timeline:main", "timeline:flashback"],
      worldlineRefs: ["worldline:prime"],
      narrativeLayerRefs: ["layer:manuscript"],
    },
    registryRevision: 1,
    registrySourceToken: "registry-token",
    registryUpdatedAt: "2026-11-04T00:00:00.000Z",
    binding: {
      schemaVersion: 1,
      projectId: "project-1",
      sceneId: "scene-1",
      sceneIncarnationId: "incarnation-1",
      compatibilityMarker: "unknown",
      queryIdentity: {
        timeline: { kind: "unresolved", reason: "legacy-axis-unknown" },
        worldline: { kind: "unresolved", reason: "legacy-axis-unknown" },
        narrativeLayer: { kind: "unresolved", reason: "legacy-axis-unknown" },
      },
      materialConstraint: {
        timeline: { kind: "any" },
        worldline: { kind: "any" },
        narrativeLayer: { kind: "any" },
      },
      knowledgeHolder: { kind: "reader" },
      audience: { kind: "reader" },
      version: 1,
      sourceToken: "token",
      updatedAt: "2026-11-04T00:00:00.000Z",
      ...binding,
    },
  };
}

const node = {
  id: "scene-1",
  nodeType: "scene",
  projectId: "project-1",
  title: "scene-1",
} as TreeNodeData;

async function renderWith(value: ScopeRead) {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "narrative_scene_scope_read") return value;
    if (command === "narrative_scene_scope_update")
      return { registry: value.registry, binding: value.binding };
    throw new Error(`unexpected ${command}`);
  });
  render(<SceneScopeEditor node={node} />);
  await waitFor(() =>
    expect(screen.getByTestId("scene-scope-controls")).toBeTruthy(),
  );
  return screen.getAllByRole("combobox") as HTMLSelectElement[];
}

function savedScope() {
  const call = invokeMock.mock.calls.find(
    ([command]) => command === "narrative_scene_scope_update",
  );
  return call?.[1].payload.scope;
}

describe("Scope 欄の query と material の追随（rev2 §7.3、A8、DR-SDEF-32）", () => {
  it("an unset Scene's material follows each query change and is saved equal to it", async () => {
    const [queryTimeline, materialTimeline] = await renderWith(read({}));
    expect(materialTimeline.disabled).toBe(true);
    const mainOption = Array.from(queryTimeline.options).find(
      (option) => option.textContent === "editor.sceneDetail.refTimelineMain",
    )!;
    fireEvent.change(queryTimeline, { target: { value: mainOption.value } });
    expect(materialTimeline.value).toBe(mainOption.value);
    expect(screen.queryByTestId("scene-scope-material-mismatch")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    });
    const scope = savedScope();
    expect(scope.queryIdentity.timeline).toEqual(MAIN);
    expect(scope.materialConstraint).toEqual(scope.queryIdentity);
  });

  it("stops following only while the material is set separately, and warns before a mismatched save", async () => {
    const selects = await renderWith(read({}));
    const [queryTimeline, materialTimeline] = selects;
    const optionValue = (select: HTMLSelectElement, label: string) =>
      Array.from(select.options).find((option) => option.textContent === label)!
        .value;
    fireEvent.change(queryTimeline, {
      target: {
        value: optionValue(queryTimeline, "editor.sceneDetail.refTimelineMain"),
      },
    });
    fireEvent.click(screen.getByTestId("scene-scope-material-separate"));
    expect(materialTimeline.disabled).toBe(false);
    fireEvent.change(queryTimeline, {
      target: { value: optionValue(queryTimeline, "timeline:flashback") },
    });
    // The material kept the followed value; the two now differ.
    expect(materialTimeline.value).toBe(
      optionValue(materialTimeline, "editor.sceneDetail.refTimelineMain"),
    );
    expect(screen.getByTestId("scene-scope-material-mismatch")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("scene-scope-binding-save"));
    });
    const scope = savedScope();
    expect(scope.queryIdentity.timeline).toEqual(FLASHBACK);
    expect(scope.materialConstraint.timeline).toEqual(MAIN);
  });

  it("warns before saving an earlier Scene while the vocabulary is empty (rev2 §7.3)", async () => {
    const value = read({ compatibilityMarker: "legacy-absent" });
    value.registry.timelineRefs = [];
    value.registry.worldlineRefs = [];
    value.registry.narrativeLayerRefs = [];
    await renderWith(value);
    expect(
      screen.getByTestId("scene-scope-legacy-empty-registry"),
    ).toBeTruthy();
    cleanup();
    await renderWith(read({ compatibilityMarker: "legacy-absent" }));
    expect(
      screen.queryByTestId("scene-scope-legacy-empty-registry"),
    ).toBeNull();
  });

  it("a saved explicit binding whose values differ starts separate and is not rewritten", async () => {
    const selects = await renderWith(
      read({
        compatibilityMarker: "explicit",
        queryIdentity: {
          timeline: MAIN,
          worldline: { kind: "exact", ref: "worldline:prime" },
          narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
        },
      }),
    );
    expect(
      (screen.getByTestId("scene-scope-material-separate") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(selects[1]!.value).toBe("kind:any");
    expect(screen.getByTestId("scene-scope-material-mismatch")).toBeTruthy();
  });
});
