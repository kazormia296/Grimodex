import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as string[],
  acquireTimelapseReplacementFence: vi.fn(),
  openOwnSaveCapture: vi.fn(),
  runAfterTimelapseGenesis: vi.fn(),
  flushStrict: vi.fn(),
}));

vi.mock("./documentCoverage", () => ({
  acquireTimelapseReplacementFence: h.acquireTimelapseReplacementFence,
  openOwnSaveCapture: h.openOwnSaveCapture,
}));
vi.mock("./genesisBarrier", () => ({
  runAfterTimelapseGenesis: h.runAfterTimelapseGenesis,
}));
vi.mock("./recorder", () => ({
  flushStrict: h.flushStrict,
}));

import {
  _resetTimelapseBodyWriteTailsForTests,
  runTimelapseBodyReplacement,
  runTimelapseBodyWrite,
  runTimelapseEditorBodyWrite,
} from "./bodyWriteMode";
import type {
  TimelapseDocumentIdentity,
  TimelapseDocumentRef,
} from "./documentCoverage";

const REF = {} as TimelapseDocumentRef;
const IDENTITY: TimelapseDocumentIdentity = {
  projectId: "project-1",
  domain: "editor",
  entityType: "scene",
  entityId: "scene-1",
  storage: "database",
};

function makeCapture(label: string) {
  return {
    commit: vi.fn(() => h.events.push(`${label}:capture.commit`)),
    release: vi.fn(() => h.events.push(`${label}:capture.release`)),
  };
}

function makeFence(label: string) {
  return {
    commit: vi.fn(() => h.events.push(`${label}:fence.commit`)),
    release: vi.fn(() => h.events.push(`${label}:fence.release`)),
  };
}

beforeEach(() => {
  h.events = [];
  h.acquireTimelapseReplacementFence.mockReset();
  h.openOwnSaveCapture.mockReset();
  h.runAfterTimelapseGenesis.mockReset();
  h.flushStrict.mockReset();
  h.runAfterTimelapseGenesis.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown>) =>
      operation(),
  );
  h.flushStrict.mockImplementation(async () => {
    h.events.push("flushStrict");
  });
  _resetTimelapseBodyWriteTailsForTests();
});

describe("timelapse body write coordination", () => {
  it("fails closed to a replacement fence before the first await", async () => {
    const fence = makeFence("covered");
    h.acquireTimelapseReplacementFence.mockImplementation(() => {
      h.events.push("covered:fence.acquire");
      return fence;
    });

    const result = runTimelapseBodyWrite(
      {
        projectId: "project-1",
        coverageReceipt: REF,
        documentIdentity: IDENTITY,
        content: "body",
      },
      {
        commit: async (coverage) => {
          h.events.push(`native.commit:${coverage?.eventUid ?? "missing"}`);
          return "native-result";
        },
        project: async (committed) => {
          h.events.push("project");
          return committed;
        },
      },
    );

    // Admission is synchronous; the body operation is queued behind the
    // project tail and has not crossed its first await yet.
    expect(h.events).toEqual(["covered:fence.acquire"]);
    await expect(result).resolves.toBe("native-result");
    expect(h.events).toEqual([
      "covered:fence.acquire",
      "flushStrict",
      "native.commit:missing",
      "covered:fence.commit",
      "project",
      "covered:fence.release",
    ]);
  });

  it("forwards a preexisting-draft permit through the async genesis coordinator", async () => {
    const fence = makeFence("preexisting");
    h.acquireTimelapseReplacementFence.mockReturnValue(fence);

    await runTimelapseBodyReplacement(
      {
        projectId: "project-1",
        documentIdentity: IDENTITY,
        preexistingDraft: true,
      },
      {
        commit: async () => "native-result",
        project: async (committed) => committed,
      },
    );

    expect(h.runAfterTimelapseGenesis).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      { preexistingDraft: true },
    );
  });

  it("serializes same-project body writers globally across documents", async () => {
    const fenceA = makeFence("a");
    const fenceB = makeFence("b");
    h.acquireTimelapseReplacementFence
      .mockImplementationOnce(() => {
        h.events.push("a:fence.acquire");
        return fenceA;
      })
      .mockImplementationOnce(() => {
        h.events.push("b:fence.acquire");
        return fenceB;
      });

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const writeA = runTimelapseBodyWrite(
      {
        projectId: "project-1",
        coverageReceipt: REF,
        documentIdentity: IDENTITY,
        content: "A",
      },
      {
        commit: async () => {
          h.events.push("a:native.commit");
          await gateA;
          return "A";
        },
        project: async (value) => {
          h.events.push(`a:project:${value}`);
          return value;
        },
      },
    );
    const writeB = runTimelapseBodyWrite(
      {
        projectId: "project-1",
        coverageReceipt: REF,
        documentIdentity: IDENTITY,
        content: "B",
      },
      {
        commit: async () => {
          h.events.push("b:native.commit");
          return "B";
        },
        project: async (value) => {
          h.events.push(`b:project:${value}`);
          return value;
        },
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(h.events).toEqual([
      "a:fence.acquire",
      "b:fence.acquire",
      "flushStrict",
      "a:native.commit",
    ]);
    releaseA();
    await expect(Promise.all([writeA, writeB])).resolves.toEqual(["A", "B"]);
    expect(h.events.indexOf("a:project:A")).toBeLessThan(
      h.events.indexOf("flushStrict", h.events.indexOf("a:project:A") + 1),
    );
    expect(h.events.indexOf("a:fence.commit")).toBeLessThan(
      h.events.indexOf("b:native.commit"),
    );
  });

  it("fallback drains strict coverage before Native replacement and releases on false commit", async () => {
    const fence = makeFence("fallback");
    h.acquireTimelapseReplacementFence.mockImplementation(() => {
      h.events.push("fallback:fence.acquire");
      return fence;
    });

    const result = await runTimelapseBodyReplacement(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => {
          h.events.push("fallback:native.commit");
          return "not-committed";
        },
        didCommit: () => false,
        project: async (value) => {
          h.events.push(`fallback:project:${value}`);
          return value;
        },
      },
    );

    expect(result).toBe("not-committed");
    expect(h.events).toEqual([
      "fallback:fence.acquire",
      "flushStrict",
      "fallback:native.commit",
      "fallback:project:not-committed",
      "fallback:fence.release",
    ]);
    expect(fence.commit).not.toHaveBeenCalled();
    expect(fence.release).toHaveBeenCalledOnce();
  });

  it("releases a replacement fence when Native fails", async () => {
    const fence = makeFence("failure");
    h.acquireTimelapseReplacementFence.mockReturnValue(fence);
    const failed = new Error("body commit failed");
    const result = runTimelapseBodyWrite(
      {
        projectId: "project-1",
        coverageReceipt: REF,
        documentIdentity: IDENTITY,
        content: "body",
      },
      {
        commit: async () => {
          h.events.push("failure:native.commit");
          throw failed;
        },
        project: async () => "unreachable",
      },
    );

    await expect(result).rejects.toBe(failed);
    expect(fence.commit).not.toHaveBeenCalled();
    expect(fence.release).toHaveBeenCalledOnce();

    const replacementFence = makeFence("replacement-failure");
    h.acquireTimelapseReplacementFence.mockReturnValue(replacementFence);
    const replacement = runTimelapseBodyReplacement(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => {
          throw failed;
        },
        project: async () => "unreachable",
      },
    );
    await expect(replacement).rejects.toBe(failed);
    expect(replacementFence.commit).not.toHaveBeenCalled();
    expect(replacementFence.release).toHaveBeenCalledOnce();
  });
});

describe("timelapse editor (own-save) body write", () => {
  it("fence も lease も取らず、最初の await の前に hold を開く", async () => {
    const capture = makeCapture("own");
    h.openOwnSaveCapture.mockImplementation(() => {
      h.events.push("own:capture.open");
      return capture;
    });

    const result = runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => {
          h.events.push("native.commit");
          return "native-result";
        },
        project: async (committed) => {
          h.events.push("project");
          return committed;
        },
      },
    );

    expect(h.events).toEqual(["own:capture.open"]);
    expect(h.openOwnSaveCapture).toHaveBeenCalledWith({
      projectId: "project-1",
      document: IDENTITY,
    });
    await expect(result).resolves.toBe("native-result");
    expect(h.acquireTimelapseReplacementFence).not.toHaveBeenCalled();
    // release は tail の内側で renderer projection の前。外側の release は冪等な 2 回目。
    expect(h.events).toEqual([
      "own:capture.open",
      "flushStrict",
      "native.commit",
      "own:capture.commit",
      "own:capture.release",
      "project",
      "own:capture.release",
    ]);
  });

  it("呼び手が開いた hold を引き取り、自分では開かない", async () => {
    const capture = makeCapture("caller");

    await runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY, capture },
      { commit: async () => "ok", project: async (value) => value },
    );

    expect(h.openOwnSaveCapture).not.toHaveBeenCalled();
    expect(capture.commit).toHaveBeenCalledOnce();
    expect(capture.release).toHaveBeenCalled();
  });

  it("(T-6 1) preexistingDraft を genesis の coordinator へ既存の 2 関数と同じ形で渡す", async () => {
    h.openOwnSaveCapture.mockReturnValue(makeCapture("draft"));

    await runTimelapseEditorBodyWrite(
      {
        projectId: "project-1",
        documentIdentity: IDENTITY,
        preexistingDraft: true,
      },
      { commit: async () => "ok", project: async (value) => value },
    );
    await runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY },
      { commit: async () => "ok", project: async (value) => value },
    );

    expect(h.runAfterTimelapseGenesis).toHaveBeenNthCalledWith(
      1,
      "project-1",
      expect.any(Function),
      { preexistingDraft: true },
    );
    expect(h.runAfterTimelapseGenesis).toHaveBeenNthCalledWith(
      2,
      "project-1",
      expect.any(Function),
      undefined,
    );
  });

  it("(T-6 2) didCommit が false なら capture.commit() を呼ばない（再基準化しない）が release は働く", async () => {
    const capture = makeCapture("nocommit");
    h.openOwnSaveCapture.mockReturnValue(capture);

    const result = await runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => "not-committed",
        didCommit: () => false,
        project: async (value) => value,
      },
    );

    expect(result).toBe("not-committed");
    expect(capture.commit).not.toHaveBeenCalled();
    expect(capture.release).toHaveBeenCalled();
  });

  it("Native の commit が失敗しても release し、project は呼ばない", async () => {
    const capture = makeCapture("failure");
    h.openOwnSaveCapture.mockReturnValue(capture);
    const failed = new Error("body commit failed");
    const project = vi.fn(async () => "unreachable");

    await expect(
      runTimelapseEditorBodyWrite(
        { projectId: "project-1", documentIdentity: IDENTITY },
        {
          commit: async () => {
            throw failed;
          },
          project,
        },
      ),
    ).rejects.toBe(failed);

    expect(capture.commit).not.toHaveBeenCalled();
    expect(capture.release).toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it("flushStrict が失敗しても release する", async () => {
    const capture = makeCapture("flush");
    h.openOwnSaveCapture.mockReturnValue(capture);
    h.flushStrict.mockRejectedValue(new Error("flush failed"));
    const commit = vi.fn(async () => "unreachable");

    await expect(
      runTimelapseEditorBodyWrite(
        { projectId: "project-1", documentIdentity: IDENTITY },
        { commit, project: async (value) => value },
      ),
    ).rejects.toThrow("flush failed");

    expect(commit).not.toHaveBeenCalled();
    expect(capture.release).toHaveBeenCalled();
  });

  it("genesis が操作を呼ばずに reject しても、外側の finally が release する", async () => {
    const capture = makeCapture("never-ran");
    h.openOwnSaveCapture.mockReturnValue(capture);
    h.runAfterTimelapseGenesis.mockRejectedValue(
      new Error("mutation authority is not current"),
    );
    const commit = vi.fn(async () => "unreachable");

    await expect(
      runTimelapseEditorBodyWrite(
        { projectId: "project-1", documentIdentity: IDENTITY },
        { commit, project: async (value) => value },
      ),
    ).rejects.toThrow("mutation authority is not current");

    expect(commit).not.toHaveBeenCalled();
    expect(capture.commit).not.toHaveBeenCalled();
    expect(capture.release).toHaveBeenCalledOnce();
  });

  it("同じ project の body 書込みは global な tail で直列化される", async () => {
    const first = makeCapture("a");
    const second = makeCapture("b");
    h.openOwnSaveCapture.mockReturnValueOnce(first).mockReturnValueOnce(second);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const writeA = runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => {
          h.events.push("a:native.commit");
          await gateA;
          return "A";
        },
        project: async (value) => value,
      },
    );
    const writeB = runTimelapseEditorBodyWrite(
      { projectId: "project-1", documentIdentity: IDENTITY },
      {
        commit: async () => {
          h.events.push("b:native.commit");
          return "B";
        },
        project: async (value) => value,
      },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(h.events).toEqual(["flushStrict", "a:native.commit"]);
    releaseA();
    await expect(Promise.all([writeA, writeB])).resolves.toEqual(["A", "B"]);
    // 前の窓の release は、次の書込みの flushStrict より前。
    expect(first.release.mock.invocationCallOrder[0]).toBeLessThan(
      second.release.mock.invocationCallOrder[0],
    );
    expect(h.events.indexOf("b:native.commit")).toBeGreaterThan(
      h.events.indexOf("a:native.commit"),
    );
  });
});
