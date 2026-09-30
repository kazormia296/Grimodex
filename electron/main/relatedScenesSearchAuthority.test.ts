import { describe, expect, it, vi } from "vitest";
import {
  createRelatedScenesSearchAuthority,
  type RelatedScenesSender,
} from "./relatedScenesSearchAuthority.js";

function sender(id: number) {
  let closed = false;
  const callbacks: (() => void)[] = [];
  const value: RelatedScenesSender = {
    id,
    isDestroyed: () => closed,
    once: (_event, callback) => {
      callbacks.push(callback);
    },
  };
  return {
    value,
    close: () => {
      closed = true;
      callbacks.forEach((callback) => callback());
    },
  };
}

describe("related-scenes main sender authority", () => {
  it("overwrites caller authority and preserves one owner across operation commands", () => {
    const authority = createRelatedScenesSearchAuthority({
      releaseOwner: vi.fn(),
    });
    const first = sender(7);
    const begin = authority.bind(
      "related_scenes_begin",
      { ownerKey: "forged", projectId: "p" },
      first.value,
    );
    expect(begin).toMatchObject({ projectId: "p" });
    expect(begin.ownerKey).not.toBe("forged");
    expect(begin.ownerKey).toMatch(/^related-scenes-owner:/);
    for (const command of [
      "related_scenes_continue",
      "related_scenes_release",
      "nir1_evidence_qualify",
    ]) {
      expect(
        authority.bind(command, { ownerKey: "copied" }, first.value).ownerKey,
      ).toBe(begin.ownerKey);
    }
  });

  it("does not share authority between WebContents instances with the same numeric id", () => {
    const authority = createRelatedScenesSearchAuthority({
      releaseOwner: vi.fn(),
    });
    const one = authority.bind("related_scenes_begin", {}, sender(1).value);
    const two = authority.bind("related_scenes_begin", {}, sender(1).value);
    expect(one.ownerKey).not.toBe(two.ownerKey);
  });

  it("releases the exact Native owner once when the sender is destroyed", async () => {
    const releaseOwner = vi.fn().mockResolvedValue(undefined);
    const authority = createRelatedScenesSearchAuthority({ releaseOwner });
    const one = sender(3);
    const bound = authority.bind("related_scenes_begin", {}, one.value);
    authority.bind("related_scenes_continue", { ticket: "t" }, one.value);
    one.close();
    await Promise.resolve();
    expect(releaseOwner).toHaveBeenCalledExactlyOnceWith(bound.ownerKey);
    expect(() => authority.bind("related_scenes_begin", {}, one.value)).toThrow(
      "RELATED_SCENES_SENDER_UNAVAILABLE",
    );
  });

  it("reports failed cleanup while keeping unrelated IPC untouched", async () => {
    const failed = vi.fn();
    const authority = createRelatedScenesSearchAuthority({
      releaseOwner: vi.fn().mockRejectedValue(new Error("native closed")),
      onReleaseFailure: failed,
    });
    const one = sender(4);
    const unrelated = { ownerKey: "unrelated" };
    expect(authority.bind("semantic_search", unrelated, one.value)).toBe(
      unrelated,
    );
    authority.bind("related_scenes_begin", {}, one.value);
    one.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(failed).toHaveBeenCalledOnce();
  });
});
