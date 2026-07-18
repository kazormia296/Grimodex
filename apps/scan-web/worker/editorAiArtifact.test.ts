import { describe, expect, it } from "vitest";
import { HOSTED_EDITOR_AI_LIMITS } from "@grimodex/scan-contract";
import type { R2BucketLike } from "./env";
import {
  InvalidEditorAiArtifactError,
  parseEditorAiArtifact,
  readEditorAiArtifact,
} from "./editorAiArtifact";

const baseArtifact = {
  schemaVersion: "grimodex-scan/editor-ai-operation/1",
  operationId: `editor-ai:${"a".repeat(64)}`,
  requestHash: "b".repeat(64),
  status: "completed",
  provider: "workers-ai",
  model: "test-model",
  costWeight: 3,
  response: "",
  toolCalls: [
    {
      id: "call-1",
      name: "search_codex",
      input: { query: "星" },
    },
  ],
} as const;

describe("Editor AI operation artifact", () => {
  it("revalidates persisted tool calls against the request allowlist", () => {
    expect(
      parseEditorAiArtifact(baseArtifact, new Set(["search_codex"])),
    ).toMatchObject({ status: "completed" });
    expect(() =>
      parseEditorAiArtifact(baseArtifact, new Set(["get_scene"])),
    ).toThrow(InvalidEditorAiArtifactError);
  });

  it("rejects oversized R2 artifacts using metadata and a defensive stream bound", async () => {
    const oversized = "x".repeat(HOSTED_EDITOR_AI_LIMITS.maxArtifactBytes + 1);
    const bucket = (size: number | undefined): R2BucketLike =>
      ({
        get: async () => ({
          body: new Response(oversized).body,
          ...(size === undefined ? {} : { size }),
        }),
      }) as unknown as R2BucketLike;

    await expect(
      readEditorAiArtifact(
        bucket(HOSTED_EDITOR_AI_LIMITS.maxArtifactBytes + 1),
        "artifact.json",
      ),
    ).rejects.toThrow("too large");
    await expect(
      readEditorAiArtifact(bucket(undefined), "artifact.json"),
    ).rejects.toThrow("too large");
  });
});
