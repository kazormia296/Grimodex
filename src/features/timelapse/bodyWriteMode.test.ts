import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as string[],
  acquireTimelapseReplacementFence: vi.fn(),
  runAfterTimelapseGenesis: vi.fn(),
  flushStrict: vi.fn(),
}));

vi.mock("./documentCoverage", () => ({
  acquireTimelapseReplacementFence: h.acquireTimelapseReplacementFence,
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

function makeFence(label: string) {
  return {
    commit: vi.fn(() => h.events.push(`${label}:fence.commit`)),
    release: vi.fn(() => h.events.push(`${label}:fence.release`)),
  };
}

beforeEach(() => {
  h.events = [];
  h.acquireTimelapseReplacementFence.mockReset();
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
