// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, clipboardMock, toastMock, workspaceState, projectState } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    clipboardMock: vi.fn<(text: string) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    toastMock: { success: vi.fn(), error: vi.fn() },
    workspaceState: {
      activeWorkspacePath: "/workspace/novel" as string | null,
      workspaceOpenRevision: 7,
      workspaceSwitchInProgress: false,
      workspaceHydrated: true,
    },
    projectState: { id: "project-1" },
  }));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: typeof workspaceState) => unknown) =>
      selector(workspaceState),
    { getState: () => workspaceState },
  ),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => projectState.id,
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings.ai.mcp.title": "MCP Integration",
        "settings.ai.mcp.description": "description",
        "settings.ai.mcp.scopeProject": "This project",
        "settings.ai.mcp.scopeProjectDesc": "project description",
        "settings.ai.mcp.scopeAll": "All projects",
        "settings.ai.mcp.scopeAllDesc": "all description",
        "settings.ai.mcp.copyReadonly": "Read-only",
        "settings.ai.mcp.copyPolicy": "Per policy",
        "settings.ai.mcp.copySuccess": "Copied",
        "settings.ai.mcp.copyFail": "Failed",
      })[key] ?? key,
  }),
}));

import { McpIntegrationSection } from "./McpIntegrationSection";

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(workspaceState, {
    activeWorkspacePath: "/workspace/novel",
    workspaceOpenRevision: 7,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
  });
  projectState.id = "project-1";
  invokeMock.mockResolvedValue({
    command: "/opt/Grimodex/resources/bin/grimodex-mcp",
    argsPrefix: ["--license-file", "/electron-user-data/license.json"],
    workspace: "/workspace/novel",
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardMock },
  });
});

describe("McpIntegrationSection", () => {
  it("passes the shell-provided argsPrefix into the copied config", async () => {
    render(<McpIntegrationSection />);

    fireEvent.click(screen.getAllByRole("button", { name: "Read-only" })[0]);

    await waitFor(() => expect(clipboardMock).toHaveBeenCalledTimes(1));
    const config = JSON.parse(clipboardMock.mock.calls[0]?.[0] as string);
    expect(config.mcpServers.grimodex).toEqual({
      command: "/opt/Grimodex/resources/bin/grimodex-mcp",
      args: [
        "--license-file",
        "/electron-user-data/license.json",
        "--workspace",
        "/workspace/novel",
        "--project",
        "project-1",
        "--readonly",
      ],
      env: {},
    });
  });

  it.each([
    { workspaceHydrated: false, workspaceSwitchInProgress: false },
    { workspaceHydrated: true, workspaceSwitchInProgress: true },
  ])("disables copy until the workspace snapshot is stable (%o)", (state) => {
    Object.assign(workspaceState, state);

    render(<McpIntegrationSection />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("does not copy a mixed workspace/project snapshot when the workspace switches during invoke", async () => {
    let resolveInvoke: ((value: unknown) => void) | undefined;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );
    render(<McpIntegrationSection />);

    fireEvent.click(screen.getAllByRole("button", { name: "Per policy" })[0]);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    Object.assign(workspaceState, {
      activeWorkspacePath: "/workspace/other",
      workspaceOpenRevision: 8,
      workspaceSwitchInProgress: false,
      workspaceHydrated: true,
    });
    projectState.id = "project-2";
    resolveInvoke?.({
      command: "/opt/Grimodex/resources/bin/grimodex-mcp",
      argsPrefix: [],
      workspace: "/workspace/novel",
    });

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(clipboardMock).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("rejects a native workspace path that differs from the captured renderer path", async () => {
    invokeMock.mockResolvedValueOnce({
      command: "/opt/Grimodex/resources/bin/grimodex-mcp",
      argsPrefix: [],
      workspace: "/workspace/other",
    });
    render(<McpIntegrationSection />);

    fireEvent.click(screen.getAllByRole("button", { name: "Read-only" })[0]);

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(clipboardMock).not.toHaveBeenCalled();
  });
});
