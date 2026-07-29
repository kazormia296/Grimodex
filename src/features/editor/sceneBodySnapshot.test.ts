import { describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { deriveSceneBodySnapshot } from "./sceneBodySnapshot";

function mark(name: string, attrs: Record<string, unknown>) {
  return { type: { name }, attrs };
}

describe("deriveSceneBodySnapshot", () => {
  it("derives all save metadata in one descendants traversal", () => {
    const sceneBeat = {
      type: { name: "sceneBeat" },
      attrs: { id: "beat-1", pov: "char-1" },
      isText: false,
      textContent: "Beat preview",
      marks: [],
    };
    const bodyText = {
      type: { name: "text" },
      attrs: {},
      isText: true,
      text: "本文",
      textContent: "本文",
      marks: [
        mark("authorship", {
          source: "human",
          model: null,
          timestamp: "2026-07-28T00:00:00.000Z",
        }),
        mark("foreshadowSetup", {
          setupId: "setup-1",
          foreshadowId: "fs-1",
        }),
        mark("peAnnotation", { annotationId: "ann-1" }),
      ],
    };
    const mention = {
      type: { name: "mention" },
      attrs: { id: "char-1", role: "actor" },
      isText: false,
      textContent: "",
      marks: [],
    };
    const descendants = vi.fn(
      (
        callback: (
          node: unknown,
          pos: number,
          parent: unknown,
        ) => boolean | void,
      ) => {
        callback(sceneBeat, 0, null);
        callback(bodyText, 1, { type: { name: "paragraph" } });
        callback(mention, 4, sceneBeat);
      },
    );
    const toJSON = vi.fn(() => ({ type: "doc", content: [] }));
    const doc = {
      descendants,
      toJSON,
      content: { size: 8 },
    } as unknown as ProseMirrorNode;

    const snapshot = deriveSceneBodySnapshot(doc, []);

    expect(descendants).toHaveBeenCalledTimes(1);
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(snapshot.charCount).toBe(2);
    expect(snapshot.placedBeatPreview).toBe('["Beat preview"]');
    expect(snapshot.authorshipSpans).toEqual([
      expect.objectContaining({ fromPos: 1, toPos: 3, source: "human" }),
    ]);
    expect(snapshot.foreshadowSetups).toEqual([
      {
        id: "setup-1",
        foreshadowId: "fs-1",
        fromPos: 1,
        toPos: 3,
      },
    ]);
    expect(snapshot.annotationAnchors).toEqual([
      {
        id: "ann-1",
        rangeStart: 1,
        rangeEnd: 3,
        textSnapshot: "本文",
      },
    ]);
    expect(snapshot.beatMentions).toEqual([
      { beatId: "beat-1", codexId: "char-1", role: "actor" },
    ]);
    expect(snapshot.beatPovOverrides).toEqual(["char-1"]);
  });

  it("skips sidecar extraction for file-backed scenes but keeps core metadata", () => {
    const text = {
      type: { name: "text" },
      attrs: {},
      isText: true,
      text: "abc",
      textContent: "abc",
      marks: [mark("authorship", { source: "ai" })],
    };
    const doc = {
      descendants: (
        callback: (
          node: unknown,
          pos: number,
          parent: unknown,
        ) => boolean | void,
      ) => callback(text, 1, { type: { name: "paragraph" } }),
      toJSON: () => ({ type: "doc" }),
      content: { size: 5 },
    } as unknown as ProseMirrorNode;

    const snapshot = deriveSceneBodySnapshot(doc, [], false);

    expect(snapshot.charCount).toBe(3);
    expect(snapshot.authorshipSpans).toEqual([]);
  });

  it("fills a legacy authorship mark's missing timestamp at save time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T12:34:56.000Z"));
    try {
      const text = {
        type: { name: "text" },
        attrs: {},
        isText: true,
        text: "legacy",
        textContent: "legacy",
        marks: [mark("authorship", { source: "human", timestamp: null })],
      };
      const doc = {
        descendants: (
          callback: (
            node: unknown,
            pos: number,
            parent: unknown,
          ) => boolean | void,
        ) => callback(text, 1, { type: { name: "paragraph" } }),
        toJSON: () => ({ type: "doc" }),
        content: { size: 8 },
      } as unknown as ProseMirrorNode;

      expect(
        deriveSceneBodySnapshot(doc, []).authorshipSpans[0]?.timestamp,
      ).toBe("2026-07-28T12:34:56.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
