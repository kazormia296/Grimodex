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
vi.mock("@/lib/sceneScopeDefault", () => ({ readScopeProjectDefault: h.read }));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ImportScopeDefaultOption } from "./ImportScopeDefaultOption";

function defaultState(state: "set" | "none") {
  return { projectId: "project-1", default: { state }, version: 1 };
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
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
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
