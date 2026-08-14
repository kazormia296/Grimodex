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
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetProjectMetadataWritesForTests();
  h.currentProjectId = "project-a";
  h.updateProject.mockReset();
  h.updateProject.mockResolvedValue({ id: "project-a" });
  h.refreshProjects.mockReset();
  h.refreshProjects.mockResolvedValue(undefined);
});

describe("Project metadata write quiescence", () => {
  it("forces a pending debounce immediately and waits for the real write", async () => {
    const write = deferred<unknown>();
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

    write.resolve({ id: "project-a" });
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

  it("coalesces different fields into one Project patch", async () => {
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "Novel",
    });
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "genre",
      value: "Mystery",
    });

    await flushQuiescenceProviderStage("scoped-mutations");

    expect(h.updateProject).toHaveBeenCalledOnce();
    expect(h.updateProject).toHaveBeenCalledWith("project-a", {
      title: "Novel",
      genre: "Mystery",
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
    const first = deferred<unknown>();
    h.updateProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ id: "project-a" });
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

    first.resolve({ id: "project-a" });
    await flush;

    expect(h.updateProject).toHaveBeenCalledTimes(2);
    expect(h.updateProject.mock.calls[1]).toEqual([
      "project-a",
      { title: "Latest" },
    ]);
  });

  it("does not recover an in-flight old generation after a newer value succeeds", async () => {
    const first = deferred<unknown>();
    h.updateProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ id: "project-a" });
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
    first.reject(new Error("old write failed"));
    await flush;

    expect(h.updateProject).toHaveBeenCalledTimes(2);
    expect(h.updateProject.mock.calls[1]).toEqual([
      "project-a",
      { title: "Latest" },
    ]);
    expect(collectQuiescenceProviderRecovery()).not.toContainEqual(
      expect.objectContaining({
        field: "title",
        value: "First",
      }),
    );

    await flushQuiescenceProviderStage("scoped-mutations");
    expect(h.updateProject).toHaveBeenCalledTimes(2);
  });

  it("retains only unchanged fields from a failed multi-field generation", async () => {
    const first = deferred<unknown>();
    h.updateProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ id: "project-a" });
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "First",
    });
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "genre",
      value: "Old",
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(h.updateProject).toHaveBeenCalledTimes(1));

    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "Latest",
    });
    first.reject(new Error("partially superseded write failed"));
    await vi.waitFor(() => expect(h.updateProject).toHaveBeenCalledTimes(2));

    expect(h.updateProject.mock.calls[1]).toEqual([
      "project-a",
      { title: "Latest" },
    ]);
    const recovery = collectQuiescenceProviderRecovery();
    expect(recovery).toContainEqual({
      kind: "project-metadata",
      projectId: "project-a",
      field: "genre",
      value: "Old",
    });
    expect(recovery).not.toContainEqual(
      expect.objectContaining({
        field: "title",
        value: "First",
      }),
    );
  });

  it("serializes a second field behind an in-flight Project patch", async () => {
    const first = deferred<unknown>();
    h.updateProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ id: "project-a" });
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "title",
      value: "First",
    });
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(h.updateProject).toHaveBeenCalledTimes(1));

    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "language",
      value: "en",
    });
    const flush = flushQuiescenceProviderStage("scoped-mutations");
    await Promise.resolve();
    expect(h.updateProject).toHaveBeenCalledTimes(1);

    first.resolve({ id: "project-a" });
    await flush;

    expect(h.updateProject).toHaveBeenCalledTimes(2);
    expect(h.updateProject.mock.calls[1]).toEqual([
      "project-a",
      { language: "en" },
    ]);
  });

  it("propagates persistence failure to strict quiescence", async () => {
    h.updateProject.mockRejectedValueOnce(new Error("metadata disk full"));
    const onFailure = vi.fn();
    scheduleProjectMetadataWrite({
      projectId: "project-a",
      field: "genre",
      value: "Mystery",
      onFailure,
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
    expect(onFailure).toHaveBeenCalledOnce();
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
