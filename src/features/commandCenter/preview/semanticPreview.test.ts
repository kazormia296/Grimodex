import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/semantic-search/api", () => ({
  getSemanticChunkContext: vi.fn(),
}));

import { getSemanticChunkContext } from "@/features/semantic-search/api";
import { fetchSemanticPreview } from "./semanticPreview";

describe("fetchSemanticPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls getSemanticChunkContext with default padding 100", async () => {
    vi.mocked(getSemanticChunkContext).mockResolvedValueOnce({
      before: "b",
      chunk: "c",
      after: "a",
      sceneTitle: "T",
    });
    await fetchSemanticPreview({
      sceneId: "s1",
      charStart: 10,
      charEnd: 30,
      score: 0.9,
    });
    expect(getSemanticChunkContext).toHaveBeenCalledWith({
      sceneId: "s1",
      charStart: 10,
      charEnd: 30,
      padding: 100,
    });
  });

  it("honors explicit padding", async () => {
    vi.mocked(getSemanticChunkContext).mockResolvedValueOnce({
      before: "",
      chunk: "",
      after: "",
      sceneTitle: "",
    });
    await fetchSemanticPreview({
      sceneId: "s1",
      charStart: 0,
      charEnd: 5,
      score: 0.5,
      padding: 50,
    });
    expect(getSemanticChunkContext).toHaveBeenCalledWith({
      sceneId: "s1",
      charStart: 0,
      charEnd: 5,
      padding: 50,
    });
  });

  it("returns mapped content + score", async () => {
    vi.mocked(getSemanticChunkContext).mockResolvedValueOnce({
      before: "前",
      chunk: "中",
      after: "後",
      sceneTitle: "第3章",
    });
    const result = await fetchSemanticPreview({
      sceneId: "s1",
      charStart: 0,
      charEnd: 1,
      score: 0.87,
    });
    expect(result).toEqual({
      kind: "semantic",
      sceneTitle: "第3章",
      before: "前",
      chunk: "中",
      after: "後",
      score: 0.87,
    });
  });
});
