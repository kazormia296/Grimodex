import { describe, it, expect } from "vitest";
import { normalizeProposal } from "./extractThreadsApi";

const allowed = new Set(["s1", "s2", "s3"]);

describe("normalizeProposal", () => {
  it("accepts a valid proposal and maps evidenceSceneId -> sceneId", () => {
    const p = normalizeProposal(
      {
        name: " Aの真実 ",
        description: " 主人公の秘密 ",
        markers: [
          { evidenceSceneId: "s1", phaseType: "introduce" },
          { evidenceSceneId: "s3", phaseType: "climax", note: " 鍵 " },
        ],
      },
      allowed,
    );
    expect(p).not.toBeNull();
    expect(p!.name).toBe("Aの真実");
    expect(p!.description).toBe("主人公の秘密");
    expect(p!.markers).toEqual([
      { sceneId: "s1", phaseType: "introduce", note: undefined },
      { sceneId: "s3", phaseType: "climax", note: "鍵" },
    ]);
  });

  it("drops markers whose sceneId is not in the allowed set (hallucination)", () => {
    const p = normalizeProposal(
      {
        name: "T",
        markers: [
          { evidenceSceneId: "s1", phaseType: "develop" },
          { evidenceSceneId: "ghost", phaseType: "develop" },
        ],
      },
      allowed,
    );
    expect(p!.markers.map((m) => m.sceneId)).toEqual(["s1"]);
  });

  it("drops markers with an invalid phaseType", () => {
    const p = normalizeProposal(
      {
        name: "T",
        markers: [
          { evidenceSceneId: "s1", phaseType: "introduce" },
          { evidenceSceneId: "s2", phaseType: "nonsense" },
        ],
      },
      allowed,
    );
    expect(p!.markers.map((m) => m.sceneId)).toEqual(["s1"]);
  });

  it("dedups markers by (sceneId, phaseType)", () => {
    const p = normalizeProposal(
      {
        name: "T",
        markers: [
          { evidenceSceneId: "s1", phaseType: "introduce" },
          { evidenceSceneId: "s1", phaseType: "introduce" },
          { evidenceSceneId: "s1", phaseType: "climax" },
        ],
      },
      allowed,
    );
    expect(p!.markers).toEqual([
      { sceneId: "s1", phaseType: "introduce", note: undefined },
      { sceneId: "s1", phaseType: "climax", note: undefined },
    ]);
  });

  it("returns null when name is empty or no valid markers remain", () => {
    expect(
      normalizeProposal(
        {
          name: "  ",
          markers: [{ evidenceSceneId: "s1", phaseType: "develop" }],
        },
        allowed,
      ),
    ).toBeNull();
    expect(
      normalizeProposal(
        {
          name: "T",
          markers: [{ evidenceSceneId: "ghost", phaseType: "develop" }],
        },
        allowed,
      ),
    ).toBeNull();
    expect(normalizeProposal({ name: "T", markers: [] }, allowed)).toBeNull();
    expect(normalizeProposal(null, allowed)).toBeNull();
    expect(normalizeProposal({ name: "T" }, allowed)).toBeNull();
  });
});
