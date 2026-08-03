import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectQuiescenceProviderRecovery,
  flushQuiescenceProviderStage,
} from "@/lib/quiescenceProviders";
import {
  _resetProjectMetadataWritesForTests,
  scheduleProjectMetadataWrite,
} from "./projectMetadataWriteQueue";

const h = vi.hoisted(() => ({
  currentProjectId: "project-a",
  updateProject: vi.fn(),
  refreshProjects: vi.fn(),
}));

vi.mock("@/features/project/api", () => ({
  updateProject: h.updateProject,
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => h.currentProjectId,
  useProjectStore: {
    getState: () => ({
      refreshProjects: h.refreshProjects,
    }),
  },
}));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetProjectMetadataWritesForTests();
  h.currentProjectId = "project-a";
  h.updateProject.mockReset();
  h.updateProject.mockResolvedValue(undefined);
  h.refreshProjects.mockReset();
  h.refreshProjects.mockResolvedValue(undefined);
});

describe("Project metadata write quiescence", () => {
  it("forces a pending debounce immediately and waits for the real write", async () => {
    const write = deferred<void>();
    h.updateProject.mockReturnValueOnce(write.promise);
    const onPersist = vi.fn();

    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "language",
      value: "en",
      onPersist,
    });

    let settled = false;
    const flush = flushQuiescenceProviderStage("scoped-mutations").then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(h.updateProject).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(h.updateProject).toHaveBeenCalledWith("project-a", {
      language: "en",
    });

    write.resolve();
    await flush;

    expect(h.refreshProjects).toHaveBeenCalledOnce();
    expect(onPersist).toHaveBeenCalledOnce();
  });

  it("coalesces a field to its latest value before strict quiescence", async () => {
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "Old title",
    });
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "Latest title",
    });

    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.updateProject).toHaveBeenCalledTimes(1);
    expect(h.updateProject).toHaveBeenCalledWith("project-a", {
      title: "Latest title",
    });
  });

  it("persists null when a nullable metadata field is explicitly cleared", async () => {
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "genre",
      value: null,
    });

    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.updateProject).toHaveBeenCalledOnce();
    expect(h.updateProject).toHaveBeenCalledWith("project-a", {
      genre: null,
    });
    expect(h.refreshProjects).toHaveBeenCalledOnce();
  });

  it("keeps one field single-flight and drains the latest queued value", async () => {
    const first = deferred<void>();
    h.updateProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "First",
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(h.updateProject).toHaveBeenCalledTimes(1));

    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "Latest",
    });
    const flush = flushQuiescenceProviderStage("scoped-mutations");
    await Promise.resolve();
    expect(h.updateProject).toHaveBeenCalledTimes(1);

    first.resolve();
    await flush;

    expect(h.updateProject).toHaveBeenCalledTimes(2);
    expect(h.updateProject.mock.calls[1]).toEqual([
      "project-a",
      { title: "Latest" },
    ]);
  });

  it("propagates persistence failure to strict quiescence", async () => {
    h.updateProject.mockRejectedValueOnce(new Error("metadata disk full"));
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "genre",
      value: "Mystery",
    });

    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).rejects.toThrow("metadata disk full");
    expect(collectQuiescenceProviderRecovery()).toContainEqual({
      kind: "project-metadata",
      projectId: "project-a",
      field: "genre",
      value: "Mystery",
    });
  });

  it("does not write after Project authority changes", async () => {
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "pov",
      value: "first-person",
    });
    h.currentProjectId = "project-b";

    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).rejects.toThrow("Project metadata write authority changed");
    expect(h.updateProject).not.toHaveBeenCalled();
  });
});
