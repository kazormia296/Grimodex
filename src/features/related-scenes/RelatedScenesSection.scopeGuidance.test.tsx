// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useSettingsStore } from "@/features/settings/settingsStore";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  hook: vi.fn(),
  setSetting: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({
  invoke: h.invoke,
  isElectron: () => true,
}));
vi.mock("./useNir1RelatedScenes", () => ({ useNir1RelatedScenes: h.hook }));
vi.mock("./Nir1RelatedSceneRow", () => ({
  Nir1RelatedSceneRow: ({
    sceneTitle,
    ir,
  }: {
    sceneTitle: string;
    ir?: unknown;
  }) => (
    <div data-testid="related-row" data-ir={ir ? "yes" : "no"}>
      {sceneTitle}
    </div>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The default badge/action is covered by its own test; here only its presence.
vi.mock("@/features/editor/sceneMeta/SceneScopeDefaultActions", () => ({
  SceneScopeDefaultActions: ({ onApplied }: { onApplied: () => void }) => (
    <button
      type="button"
      data-testid="scope-default-actions"
      onClick={onApplied}
    />
  ),
}));

import { RelatedScenesSection } from "./RelatedScenesSection";

const MAIN_LINE = {
  timeline: { kind: "exact", ref: "timeline:main" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};

function baseFetch(
  result: Nir1RelatedScenesFetchResult["result"],
): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "qb",
    initialSnapshot: null,
    completion: null,
    rawScenes: [],
    result,
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
  };
}

const unsupported = baseFetch({
  kind: "raw",
  scenes: [],
  ir: { status: "unavailable", reason: "unsupported-query" },
} as never);

function binding(marker: string, query: unknown = MAIN_LINE) {
  return {
    registry: {},
    registryRevision: 1,
    binding: {
      projectId: "project-1",
      sceneId: "scene-1",
      compatibilityMarker: marker,
      queryIdentity: query,
      materialConstraint: query,
      version: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTreeStore.setState({
    nodes: [{ id: "scene-1", projectId: "project-1", nodeType: "scene" }],
    activeSceneId: "scene-1",
  } as never);
  useWorkspaceStore.setState({ activeWorkspacePath: "/workspace" } as never);
  vi.spyOn(useSettingsStore.getState(), "set").mockImplementation(h.setSetting);
});
afterEach(cleanup);

describe("関連場面の Scope の案内（rev2 §7.4、DR-SDEF-33）", () => {
  it("A1 の renderer 側：本筋の場面どうしの IR の行が出て、案内も Scope の読取も出ない", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: baseFetch({
        kind: "fused",
        scenes: [
          {
            kind: "ir",
            sceneId: "scene-2",
            sceneTitle: "本筋の前の場面",
            rank1: 1,
            ir: { sceneId: "scene-2" },
          },
        ],
        ir: { status: "available" },
      } as never),
    });
    render(<RelatedScenesSection enabled />);
    expect(screen.getByTestId("related-row").dataset.ir).toBe("yes");
    expect(screen.queryByTestId("nir1-unavailable")).toBeNull();
    expect(screen.queryByTestId("nir1-scope-guidance")).toBeNull();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("未設定の場面では原因と「Scope を設定」「既定を当てる」を出す（取り消し・やり直しを含む文言）", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: unsupported,
    });
    h.invoke.mockResolvedValue(binding("unknown"));
    render(<RelatedScenesSection enabled />);
    expect(await screen.findByTestId("nir1-scope-guidance")).toBeTruthy();
    expect(screen.getByText("relatedScenes.scopeUnknown")).toBeTruthy();
    expect(h.invoke).toHaveBeenCalledWith("narrative_scene_scope_read", {
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      sceneId: "scene-1",
    });
    expect(screen.getByTestId("scope-default-actions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("nir1-scope-guidance-open"));
    expect(h.setSetting).toHaveBeenCalledWith(
      "editor.sceneMetaPanelOpen",
      "true",
    );
  });

  it("当てた後は、関連場面が次に開き直したときに反映されることを案内する（DR-SDEF-38）", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: unsupported,
    });
    h.invoke.mockResolvedValueOnce(binding("unknown"));
    h.invoke.mockResolvedValueOnce(binding("explicit"));
    render(<RelatedScenesSection enabled />);
    fireEvent.click(await screen.findByTestId("scope-default-actions"));
    expect(
      await screen.findByTestId("nir1-scope-guidance-applied"),
    ).toBeTruthy();
    expect(screen.getByText("relatedScenes.scopeApplied")).toBeTruthy();
  });

  it("以前からの場面は未設定の文言で、1 クリックの「既定を当てる」は出さない", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: unsupported,
    });
    h.invoke.mockResolvedValue(binding("legacy-absent"));
    render(<RelatedScenesSection enabled />);
    expect(await screen.findByTestId("nir1-scope-guidance")).toBeTruthy();
    // Its own wording: the undo/redo/import sentence is about unset Scenes.
    expect(screen.getByText("relatedScenes.scopeLegacy")).toBeTruthy();
    expect(screen.queryByText("relatedScenes.scopeUnknown")).toBeNull();
    expect(screen.queryByTestId("scope-default-actions")).toBeNull();
  });

  it("未解決の軸のある明示の場面では未解決の文言を出す", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: unsupported,
    });
    h.invoke.mockResolvedValue(
      binding("explicit", {
        ...MAIN_LINE,
        worldline: { kind: "unresolved", reason: "x" },
      }),
    );
    render(<RelatedScenesSection enabled />);
    expect(
      await screen.findByText("relatedScenes.scopeUnresolved"),
    ).toBeTruthy();
  });

  it("Scope 以外が原因か、読めないときは今の文言に戻る", async () => {
    h.hook.mockReturnValue({
      sceneId: "scene-1",
      loading: false,
      fetch: unsupported,
    });
    h.invoke.mockRejectedValue(new Error("unavailable"));
    render(<RelatedScenesSection enabled />);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByText("relatedScenes.irUnsupported")).toBeTruthy(),
    );
    expect(screen.queryByTestId("nir1-scope-guidance")).toBeNull();
    cleanup();

    h.invoke.mockResolvedValue(binding("explicit"));
    render(<RelatedScenesSection enabled />);
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText("relatedScenes.irUnsupported")).toBeTruthy(),
    );
    expect(screen.queryByTestId("nir1-scope-guidance")).toBeNull();
  });
});
