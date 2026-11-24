import { beforeEach, describe, expect, it, vi } from "vitest";

const { extractMock, loadMock, saveMock, toastErrorMock } = vi.hoisted(() => ({
  extractMock: vi.fn(),
  loadMock: vi.fn(),
  saveMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

vi.mock("./candidateExtractor", () => ({
  extractCodexCandidatesResult: extractMock,
}));
vi.mock("./codexCandidateDismissals", () => ({
  loadDismissedCandidateKeys: loadMock,
  saveDismissedCandidateKeys: saveMock,
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  useCodexCandidateHostStore,
  selectCodexCandidateCount,
} from "./codexCandidateHostStore";
import type { CodexCandidate } from "./candidateExtractor";
import type { CodexCandidateScanResult } from "./candidateExtractor";

function candidate(surface: string): CodexCandidate {
  return {
    surface,
    lemma: surface,
    count: 2,
    firstSceneId: "scene-1",
    context: "",
  };
}

function result(...surfaces: string[]): CodexCandidateScanResult {
  return { ok: true, candidates: surfaces.map(candidate) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const store = () => useCodexCandidateHostStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  useGlobalHistoryStore.getState().clear();
  loadMock.mockResolvedValue(new Set());
  saveMock.mockResolvedValue(undefined);
  extractMock.mockResolvedValue(result("空"));
});

describe("syncProject", () => {
  it("is idempotent, clears on change, and ignores an old dismissal read", async () => {
    const oldRead = deferred<Set<string>>();
    loadMock.mockImplementation((projectId: string) =>
      projectId === "p1" ? oldRead.promise : Promise.resolve(new Set(["雨"])),
    );

    store().syncProject("p1");
    const firstGeneration = store().generation;
    expect(extractMock).not.toHaveBeenCalled();
    store().syncProject("p1");
    expect(store().generation).toBe(firstGeneration);
    expect(loadMock).toHaveBeenCalledTimes(1);

    useCodexCandidateHostStore.setState({
      scan: { status: "done", candidates: [candidate("空")] },
      dismissed: new Set(["空"]),
      dismissedLoaded: true,
    });
    store().syncProject("p2");
    expect(extractMock).not.toHaveBeenCalled();
    expect(store().generation).toBe(firstGeneration + 1);
    expect(store().scan).toEqual({ status: "idle", candidates: [] });
    expect(store().dismissed).toEqual(new Set());
    expect(store().dismissedLoaded).toBe(false);

    oldRead.resolve(new Set(["雲"]));
    await vi.waitFor(() => expect(store().dismissedLoaded).toBe(true));
    expect(store().dismissed).toEqual(new Set(["雨"]));
  });
});

describe("requestScan", () => {
  it("coalesces concurrent scans and reuses a completed result", async () => {
    store().syncProject("p1");
    const pending = deferred<CodexCandidateScanResult>();
    extractMock.mockReturnValue(pending.promise);

    const first = store().requestScan();
    const second = store().requestScan();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1));
    pending.resolve(result("空"));
    await Promise.all([first, second]);
    await store().requestScan();

    expect(extractMock).toHaveBeenCalledTimes(1);
    expect(store().scan).toEqual({
      status: "done",
      candidates: [candidate("空")],
    });
  });

  it("refresh joins a running scan, but rescans a completed one without bumping the generation", async () => {
    store().syncProject("p1");
    const running = deferred<CodexCandidateScanResult>();
    extractMock.mockReturnValue(running.promise);

    const first = store().requestScan({ refresh: true });
    const joined = store().requestScan({ refresh: true });
    expect(joined).toBe(first);
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1));
    running.resolve(result("空"));
    await Promise.all([first, joined]);
    expect(store().scan.status).toBe("done");

    const generation = store().generation;
    extractMock.mockResolvedValue(result("空", "雨"));
    await store().requestScan({ refresh: true });

    expect(extractMock).toHaveBeenCalledTimes(2);
    expect(store().generation).toBe(generation);
    expect(store().scan).toEqual({
      status: "done",
      candidates: [candidate("空"), candidate("雨")],
    });
  });

  it("coalesces repeated force requests into one trailing scan and keeps old candidates while scanning", async () => {
    store().syncProject("p1");
    useCodexCandidateHostStore.setState({
      scan: { status: "done", candidates: [candidate("空")] },
    });
    const firstRun = deferred<CodexCandidateScanResult>();
    const trailingRun = deferred<CodexCandidateScanResult>();
    extractMock
      .mockReturnValueOnce(firstRun.promise)
      .mockReturnValueOnce(trailingRun.promise);

    const initialGeneration = store().generation;
    const first = store().requestScan({ force: true });
    expect(store().generation).toBe(initialGeneration + 1);
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1));
    const forced1 = store().requestScan({ force: true });
    const forced2 = store().requestScan({ force: true });
    const forced3 = store().requestScan({ force: true });
    expect(store().generation).toBe(initialGeneration + 4);
    expect(forced2).toBe(forced1);
    expect(forced3).toBe(forced1);
    expect(store().scan).toEqual({
      status: "scanning",
      candidates: [candidate("空")],
    });

    firstRun.resolve(result("雲"));
    await first;
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(2));
    expect(store().scan).toEqual({
      status: "scanning",
      candidates: [candidate("空")],
    });
    trailingRun.resolve(result("雨"));
    await Promise.all([forced1, forced2, forced3]);

    expect(extractMock).toHaveBeenCalledTimes(2);
    expect(store().scan).toEqual({
      status: "done",
      candidates: [candidate("雨")],
    });
  });

  it("drops a stale result and scans the newly selected project", async () => {
    store().syncProject("p1");
    const oldRun = deferred<CodexCandidateScanResult>();
    const newRun = deferred<CodexCandidateScanResult>();
    extractMock
      .mockReturnValueOnce(oldRun.promise)
      .mockReturnValueOnce(newRun.promise);
    const oldRequest = store().requestScan();
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1));

    store().syncProject("p2");
    const newRequest = store().requestScan();
    expect(store().scan).toEqual({ status: "scanning", candidates: [] });
    oldRun.resolve(result("空"));
    await oldRequest;
    await vi.waitFor(() => expect(extractMock).toHaveBeenCalledTimes(2));
    expect(store().projectId).toBe("p2");
    expect(store().scan).toEqual({ status: "scanning", candidates: [] });
    newRun.resolve(result("雲"));
    await newRequest;

    expect(store().scan).toEqual({
      status: "done",
      candidates: [candidate("雲")],
    });
  });

  it("marks a failed scan unavailable with no candidates", async () => {
    store().syncProject("p1");
    extractMock.mockResolvedValue({ ok: false });

    await store().requestScan();

    expect(store().scan).toEqual({ status: "failed", candidates: [] });
  });
});

describe("selectCodexCandidateCount", () => {
  const entries = [{ name: "空", aliases: JSON.stringify(["雲"]) }];

  it("returns not-counted until both scan and dismissal reads are ready", () => {
    const state = store();
    expect(selectCodexCandidateCount(state, entries)).toEqual({
      status: "not-counted",
    });
    expect(
      selectCodexCandidateCount(
        { ...state, scan: { status: "done", candidates: [candidate("星")] } },
        entries,
      ),
    ).toEqual({ status: "not-counted" });
    expect(
      selectCodexCandidateCount(
        {
          ...state,
          scan: { status: "scanning", candidates: [candidate("星")] },
          dismissedLoaded: true,
        },
        entries,
      ),
    ).toEqual({ status: "not-counted" });
  });

  it("excludes registered names, aliases, and dismissed keys, including ready zero", () => {
    const ready = {
      ...store(),
      scan: {
        status: "done" as const,
        candidates: [
          candidate("空"),
          candidate("雲"),
          candidate("星"),
          candidate("川"),
        ],
      },
      dismissed: new Set(["星"]),
      dismissedLoaded: true,
    };
    expect(selectCodexCandidateCount(ready, entries)).toEqual({
      status: "ready",
      count: 1,
    });
    expect(
      selectCodexCandidateCount(
        { ...ready, scan: { ...ready.scan, candidates: [candidate("空")] } },
        entries,
      ),
    ).toEqual({ status: "ready", count: 0 });
    expect(
      selectCodexCandidateCount(
        { ...ready, scan: { status: "failed", candidates: [] } },
        entries,
      ),
    ).toEqual({ status: "unavailable" });
  });
});

describe("mutateDismissed", () => {
  it("serializes writes", async () => {
    store().syncProject("p1");
    const firstWrite = deferred<void>();
    saveMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(undefined);
    const empty = new Set<string>();
    const first = new Set(["空"]);
    const second = new Set(["空", "雲"]);

    store().mutateDismissed(first, empty, "dismiss", () => "保存失敗");
    store().mutateDismissed(second, first, "dismiss", () => "保存失敗");
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    expect(saveMock).toHaveBeenNthCalledWith(1, "p1", first);
    firstWrite.resolve();
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));
    expect(saveMock).toHaveBeenNthCalledWith(2, "p1", second);
  });

  it("reloads on the current write failure", async () => {
    loadMock
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(["雨"]));
    saveMock.mockRejectedValueOnce(new Error("write failed"));
    store().syncProject("p1");
    await vi.waitFor(() => expect(store().dismissedLoaded).toBe(true));

    store().mutateDismissed(
      new Set(["空"]),
      new Set(),
      "dismiss",
      () => "保存失敗",
    );
    await vi.waitFor(() => expect(store().dismissed).toEqual(new Set(["雨"])));

    expect(toastErrorMock).toHaveBeenCalledWith("保存失敗", {
      description: "Error: write failed",
    });
    expect(loadMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer dismissal when an older write fails", async () => {
    store().syncProject("p1");
    await vi.waitFor(() => expect(store().dismissedLoaded).toBe(true));
    const firstWrite = deferred<void>();
    saveMock
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValue(undefined);
    const first = new Set(["空"]);
    const second = new Set(["空", "雲"]);

    store().mutateDismissed(first, new Set(), "dismiss", () => "保存失敗");
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    store().mutateDismissed(second, first, "dismiss", () => "保存失敗");
    firstWrite.reject(new Error("write failed"));
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(2));

    expect(store().dismissed).toBe(second);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("undo after a project switch writes only to the captured project", async () => {
    store().syncProject("p1");
    await vi.waitFor(() => expect(store().dismissedLoaded).toBe(true));
    store().mutateDismissed(
      new Set(["空"]),
      new Set(),
      "dismiss",
      () => "保存失敗",
    );
    await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));

    store().syncProject("p2");
    await useGlobalHistoryStore.getState().undo();

    expect(saveMock.mock.calls.map(([projectId]) => projectId)).toEqual([
      "p1",
      "p1",
    ]);
    expect(store().projectId).toBe("p2");
    expect(store().dismissed).toEqual(new Set());
  });
});
