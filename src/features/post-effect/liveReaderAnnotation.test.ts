import { describe, expect, it } from "vitest";
import type { PostEffectAnnotation } from "./types";
import {
  buildLiveReaderAnnotation,
  isLiveReaderAnnotation,
} from "./liveReaderAnnotation";

describe("live reader annotation contract", () => {
  it("builds a pseudo_comment annotation with a durable live marker", () => {
    const annotation = buildLiveReaderAnnotation({
      annotationId: "annotation-1",
      projectId: "project-1",
      sceneId: "scene-1",
      runId: "run-1",
      model: "reader-model",
      content: "ここは先が気になります。",
      persona: "一般読者",
      foundText: "扉が開いた",
      foundContext: "彼は扉が開いた瞬間、息を止めた。",
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    expect(annotation.category).toBe("pseudo_comment");
    expect(annotation.status).toBe("open");
    expect(annotation.content).toBe("ここは先が気になります。");
    expect(annotation.textSnapshot).toBe("扉が開いた");
    expect(JSON.parse(annotation.metadata)).toMatchObject({
      live: true,
      found_text: "扉が開いた",
      found_context: "彼は扉が開いた瞬間、息を止めた。",
      detected_by_model: "reader-model",
    });
    expect(isLiveReaderAnnotation(annotation)).toBe(true);
  });

  it("does not classify ordinary pseudo comments as live", () => {
    const ordinary: PostEffectAnnotation = {
      id: "ordinary",
      projectId: "project-1",
      runId: "run-1",
      anchorType: "scene_range",
      sceneId: "scene-1",
      rangeStart: 0,
      rangeEnd: 2,
      textSnapshot: "本文",
      category: "pseudo_comment",
      persona: "一般読者",
      severity: null,
      content: "通常の疑似コメント",
      authorRole: "ai",
      parentId: null,
      status: "open",
      metadata: JSON.stringify({ persona: "一般読者" }),
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };

    expect(isLiveReaderAnnotation(ordinary)).toBe(false);
  });
});
