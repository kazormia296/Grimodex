import { describe, expect, it } from "vitest";

import { markChronicleRevealScene } from "./chronicleRevealMark.js";

const order = new Map([
  ["s1", 0],
  ["s2", 1],
  ["s3", 2],
]);
const titles = new Map([
  ["s1", "Scene 1"],
  ["s2", "Scene 2"],
  ["s3", "Scene 3"],
]);

describe("markChronicleRevealScene", () => {
  it.each([null, ""])("omits a missing reveal scene (%j)", (id) => {
    expect(markChronicleRevealScene(id, "s3", order, titles)).toBeNull();
  });

  it("omits a reveal scene outside the reading order", () => {
    expect(
      markChronicleRevealScene("archived", "s3", order, titles),
    ).toBeNull();
  });

  it.each([null, "archived"])(
    "includes the scene without judging an absent or out-of-order current scene (%j)",
    (currentSceneId) => {
      const mark = markChronicleRevealScene(
        "s2",
        currentSceneId,
        order,
        titles,
      );
      expect(mark).toEqual({ id: "s2", title: "Scene 2" });
      expect(mark && Object.hasOwn(mark, "revealedToReader")).toBe(false);
    },
  );

  it("marks a scene before disclosure as not yet known", () => {
    expect(markChronicleRevealScene("s2", "s1", order, titles)).toEqual({
      id: "s2",
      title: "Scene 2",
      revealedToReader: false,
    });
  });

  it.each(["s2", "s3"])(
    "marks disclosure at or before the current scene as known (%s)",
    (currentSceneId) => {
      expect(
        markChronicleRevealScene("s2", currentSceneId, order, titles),
      ).toEqual({
        id: "s2",
        title: "Scene 2",
        revealedToReader: true,
      });
    },
  );
});
