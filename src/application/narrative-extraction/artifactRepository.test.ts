import { beforeEach, describe, expect, it, vi } from "vitest";

const getRunReviewBundleMock = vi.hoisted(() => vi.fn());

vi.mock("./nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./nativeApi")>();
  return {
    ...actual,
    narrativeExtractionGetRunReviewBundle: getRunReviewBundleMock,
  };
});

import {
  buildInlineJsonArtifact,
  hydrateInlineArtifactsFromNative,
  listInlineJsonArtifacts,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
  resetNarrativeArtifactIndexForTests,
} from "./artifactRepository";

describe("narrative extraction artifact cache isolation", () => {
  beforeEach(() => {
    resetNarrativeArtifactIndexForTests();
    getRunReviewBundleMock.mockReset();
  });

  it("clones local artifact JSON on write and every cache read", async () => {
    const draft = buildInlineJsonArtifact("test.artifact@1", {
      nested: { value: "sealed" },
    });
    rememberInlineJsonArtifact({
      runId: "run-cache-local",
      taskId: "task-cache-local",
      attemptId: "attempt-cache-local",
      draft,
    });

    // A producer retaining the draft cannot alter the cache entry after task
    // terminalization.
    (draft.payloadJson.nested as { value: string }).value = "mutated-draft";
    const first = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-local", "test.artifact@1");
    expect(first?.nested.value).toBe("sealed");

    // Nor can a consumer mutate a returned payload or a listed artifact and
    // affect a later Stage's durable-prefix input.
    if (!first) throw new Error("expected local artifact");
    first.nested.value = "mutated-read";
    const listed = listInlineJsonArtifacts("run-cache-local");
    (listed[0]?.payloadJson as { nested: { value: string } }).nested.value =
      "mutated-list";
    const second = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-local", "test.artifact@1");
    expect(second?.nested.value).toBe("sealed");
  });

  it("does not share hydrated bundle or artifact references across callers", async () => {
    getRunReviewBundleMock.mockResolvedValue({
      runId: "run-cache-hydrated",
      projectId: "project-cache",
      artifacts: [
        {
          artifactId: "artifact-hydrated",
          runId: "run-cache-hydrated",
          taskId: "task-hydrated",
          attemptId: "attempt-hydrated",
          artifactKind: "test.hydrated@1",
          payloadStorage: "inline-json",
          payloadJson: { nested: { value: "sealed" } },
          payloadRef: null,
          payloadDigest: "sha256:fixture",
          createdAt: "2026-08-26T00:00:00.000Z",
        },
      ],
      stageReceipts: [],
      proposalSet: null,
      proposals: [],
    });

    const [first, second] = await Promise.all([
      hydrateInlineArtifactsFromNative({
        runId: "run-cache-hydrated",
        projectId: "project-cache",
      }),
      hydrateInlineArtifactsFromNative({
        runId: "run-cache-hydrated",
        projectId: "project-cache",
      }),
    ]);
    expect(getRunReviewBundleMock).toHaveBeenCalledTimes(1);
    const firstPayload = first.artifacts[0]?.payloadJson as {
      nested: { value: string };
    };
    firstPayload.nested.value = "mutated-first-caller";
    expect(
      (second.artifacts[0]?.payloadJson as { nested: { value: string } }).nested
        .value,
    ).toBe("sealed");

    const cached = await loadInlineJsonArtifact<{
      nested: { value: string };
    }>("run-cache-hydrated", "test.hydrated@1");
    expect(cached?.nested.value).toBe("sealed");
  });
});
