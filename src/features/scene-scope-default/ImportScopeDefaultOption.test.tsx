// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/features/workspace/store";

const h = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn(), isElectron: () => true }));
vi.mock("@/lib/sceneScopeDefault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sceneScopeDefault")>()),
  readScopeProjectDefault: h.read,
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { ImportScopeDefaultOption } from "./ImportScopeDefaultOption";

const LOCAL = {
  timeline: { kind: "exact", ref: "timeline:local" },
  worldline: { kind: "exact", ref: "worldline:prime" },
  narrativeLayer: { kind: "exact", ref: "layer:manuscript" },
};

function defaultState(state: "set" | "none") {
  return {
    projectId: "project-1",
    default:
      state === "set"
        ? { state, queryIdentity: LOCAL, materialConstraint: LOCAL }
        : { state },
    version: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ activeWorkspacePath: "/workspace" } as never);
});
afterEach(cleanup);

describe("取り込みの画面のチェック（SDEF/1 R14、DR-SDEF-31）", () => {
  it("starts OFF and can be turned on for the current project with a default", async () => {
    h.read.mockResolvedValue(defaultState("set"));
    const onChange = vi.fn();
    render(
      <ImportScopeDefaultOption
        importTarget="currentProject"
        checked={false}
        onChange={onChange}
      />,
    );
    const box = screen.getByTestId(
      "import-scene-scope-apply-default",
    ) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await waitFor(() => expect(box.disabled).toBe(false));
    // The value is the project's actual default, not an assumed main line
    // (PR-2 review P2-2).
    expect(
      screen.getByTestId("import-scene-scope-default-value").textContent,
    ).toBe(
      'import.sceneScopeApplyValue:{"value":"timeline:local / editor.sceneDetail.refWorldlinePrime / editor.sceneDetail.refLayerManuscript"}',
    );
    fireEvent.click(box);
    // ON carries the version of the default shown (P3-b).
    expect(onChange).toHaveBeenCalledWith({ expectedVersion: 1 });
  });

  it("is unavailable for a new project, which has no default", () => {
    render(
      <ImportScopeDefaultOption
        importTarget="newProject"
        checked={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      (
        screen.getByTestId(
          "import-scene-scope-apply-default",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("import.sceneScopeApplyNewProject")).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("is unavailable when the current project has no default and turns a stale ON off", async () => {
    h.read.mockResolvedValue(defaultState("none"));
    const onChange = vi.fn();
    render(
      <ImportScopeDefaultOption
        importTarget="currentProject"
        checked
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(h.read).toHaveBeenCalled());
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByText("import.sceneScopeApplyNoDefault")).toBeTruthy();
  });
});
