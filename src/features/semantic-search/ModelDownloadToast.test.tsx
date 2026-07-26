// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtime, ensureMock } = vi.hoisted(() => ({
  runtime: {
    workspacePath: "/workspace/a" as string | null,
    projectId: "p1" as string | null,
  },
  ensureMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspacePath: runtime.workspacePath }),
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ currentProjectId: runtime.projectId }),
  },
}));
vi.mock("./autoIndex", () => ({
  ensureSemanticIndexesOnOpen: ensureMock,
}));

import { ModelDownloadToast } from "./ModelDownloadToast";
import {
  _resetModelDownloadForTests,
  useModelDownloadStore,
} from "./modelDownloadStore";

beforeEach(() => {
  ensureMock.mockClear();
  runtime.workspacePath = "/workspace/a";
  runtime.projectId = "p1";
  _resetModelDownloadForTests();
});

afterEach(() => {
  cleanup();
  _resetModelDownloadForTests();
});

describe("ModelDownloadToast", () => {
  it("retries the active workspace after a terminal download failure", async () => {
    useModelDownloadStore.getState().setProgress({
      dirName: "ruri-v3-30m",
      downloaded: 1,
      total: 10,
      done: true,
      error: "network timeout",
    });
    render(<ModelDownloadToast />);

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "再試行" }));

    expect(ensureMock).toHaveBeenCalledWith("p1", "/workspace/a");
    expect(useModelDownloadStore.getState().active).toBe(false);
  });
});
