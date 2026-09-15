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
import i18next from "@/lib/i18n";

beforeEach(() => {
  ensureMock.mockClear();
  runtime.workspacePath = "/workspace/a";
  runtime.projectId = "p1";
  _resetModelDownloadForTests();
});

afterEach(async () => {
  cleanup();
  _resetModelDownloadForTests();
  await i18next.changeLanguage("ja");
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

  it("renders the English model-download failure copy", async () => {
    await i18next.changeLanguage("en");
    useModelDownloadStore.getState().setProgress({
      dirName: "ruri-v3-30m",
      downloaded: 1,
      total: 10,
      done: true,
      error: "network timeout",
    });

    render(<ModelDownloadToast />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Embedding model download failed",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Continuing with full-text search (FTS)",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("keeps the model-download and common retry keys in both locales", () => {
    for (const key of [
      "semanticSearch.modelDownloadFailed",
      "semanticSearch.modelDownloadComplete",
      "semanticSearch.modelDownloading",
      "semanticSearch.modelDownloadFallback",
      "semanticSearch.retryModelDownload",
      "common.retry",
    ]) {
      expect(
        i18next.getResource("ja", "translation", key),
        `ja ${key}`,
      ).toEqual(expect.any(String));
      expect(
        i18next.getResource("en", "translation", key),
        `en ${key}`,
      ).toEqual(expect.any(String));
    }
  });
});
