import { describe, expect, it } from "vitest";
import { runTemporalLiteralPrepass } from "./temporalLiteralPrepass";
import {
  buildAttachmentCandidates,
  validateAttachmentNodeRefs,
} from "./attachmentCandidates";

describe("runTemporalLiteralPrepass", () => {
  it("extracts absolute years", () => {
    const hits = runTemporalLiteralPrepass("共和国暦183年の冬");
    expect(
      hits.some(
        (h) => h.expression.kind === "absolute" && h.expression.year === 183,
      ),
    ).toBe(true);
  });

  it("parses relative 三日後", () => {
    const hits = runTemporalLiteralPrepass(
      "王都が陥落した三日後、教会は砲撃された。",
    );
    const rel = hits.find((h) => h.expression.kind === "relative");
    expect(rel?.expression).toMatchObject({
      kind: "relative",
      direction: "after",
      amount: { min: 3, max: 3, unit: "day" },
    });
  });

  it("parses 十年以上前 as a range", () => {
    const hits = runTemporalLiteralPrepass("十年以上前に王位を失った");
    const rel = hits.find((h) => h.expression.kind === "relative");
    expect(rel?.expression.kind).toBe("relative");
    if (rel?.expression.kind === "relative") {
      expect(rel.expression.direction).toBe("before");
      expect(rel.expression.qualifier).toBe("at-least");
      expect(rel.expression.amount?.min).toBe(10);
    }
  });

  it("keeps 同じ夜 qualitative / non-numeric", () => {
    const hits = runTemporalLiteralPrepass("同じ夜に戻った");
    const q = hits.find((h) => h.surface.includes("同じ夜"));
    expect(q?.expression.kind).toBe("qualitative");
  });

  it("does not invent minutes for しばらく後", () => {
    const hits = runTemporalLiteralPrepass("しばらく後に彼女は戻った");
    const q = hits.find((h) => h.surface === "しばらく後");
    expect(q?.expression.kind).toBe("qualitative");
  });
});

describe("buildAttachmentCandidates", () => {
  it("resolves when the same sentence has one event", () => {
    const result = buildAttachmentCandidates({
      expressionFrom: 10,
      expressionTo: 14,
      sameSentenceNodeIds: ["tn:fall"],
      sameParagraphNodeIds: ["tn:fall", "tn:other"],
      sameWindowNodeIds: [],
      namedEventNodeIds: [],
      sceneFrameNodeId: null,
      previousSceneLastNodeId: null,
      nearbyChronicleNodeIds: [],
    });
    expect(result).toEqual({ status: "resolved", nodeId: "tn:fall" });
  });

  it("stays ambiguous when multiple same-sentence candidates exist", () => {
    const result = buildAttachmentCandidates({
      expressionFrom: 0,
      expressionTo: 3,
      sameSentenceNodeIds: ["tn:a", "tn:b"],
      sameParagraphNodeIds: [],
      sameWindowNodeIds: [],
      namedEventNodeIds: [],
      sceneFrameNodeId: null,
      previousSceneLastNodeId: null,
      nearbyChronicleNodeIds: [],
    });
    expect(result.status).toBe("ambiguous");
  });

  it("rejects unknown node refs from the model", () => {
    const validated = validateAttachmentNodeRefs(
      ["tn:a", "tn:evil"],
      new Set(["tn:a"]),
    );
    expect(validated.ok).toBe(false);
  });
});
