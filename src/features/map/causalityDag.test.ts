import { describe, it, expect } from "vitest";
import {
  buildCausalityDag,
  extractCausalEdges,
  type CausalAnnotationInput,
  type CausalEdgeInput,
  type CausalScene,
} from "./causalityDag";

function scene(id: string, title = `title-${id}`): CausalScene {
  return { id, title };
}

/** cause→effect の生入力 (annotation から抽出済みの形)。 */
function edge(
  causeSceneId: string | null | undefined,
  effectSceneId: string | null | undefined,
  reason?: string,
): CausalEdgeInput {
  return { causeSceneId, effectSceneId, reason };
}

const SCENES = [scene("a"), scene("b"), scene("c"), scene("d")];

describe("buildCausalityDag", () => {
  it("cause→effect の有向辺を実在シーンから構築する", () => {
    const dag = buildCausalityDag(SCENES, [edge("a", "b", "A が B を招く")]);
    expect(dag.edges).toEqual([{ from: "a", to: "b", label: "A が B を招く" }]);
    expect(dag.nodes.map((n) => n.sceneId).sort()).toEqual(["a", "b"]);
    expect(dag.nodes.find((n) => n.sceneId === "a")?.title).toBe("title-a");
    expect(dag.cycles).toEqual([]);
  });

  it("cause か effect が欠落した辺は捨てる", () => {
    const dag = buildCausalityDag(SCENES, [
      edge(null, "b"),
      edge("a", null),
      edge(undefined, undefined),
      edge("", "b"),
      edge("a", "c"),
    ]);
    expect(dag.edges).toEqual([{ from: "a", to: "c", label: undefined }]);
  });

  it("実在しないシーンを指す辺は捨てる (LLM hallucination 対策)", () => {
    const dag = buildCausalityDag(SCENES, [
      edge("ghost", "b"),
      edge("a", "ghost"),
      edge("a", "b"),
    ]);
    expect(dag.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b"]);
  });

  it("自己ループ (cause===effect) は捨てる", () => {
    const dag = buildCausalityDag(SCENES, [edge("a", "a"), edge("a", "b")]);
    expect(dag.edges.map((e) => `${e.from}->${e.to}`)).toEqual(["a->b"]);
  });

  it("同一 (from,to) は重複排除し最初の reason を残す", () => {
    const dag = buildCausalityDag(SCENES, [
      edge("a", "b", "理由1"),
      edge("a", "b", "理由2"),
    ]);
    expect(dag.edges).toEqual([{ from: "a", to: "b", label: "理由1" }]);
  });

  it("辺に現れるシーンだけをノードにする (孤立シーンは除外)", () => {
    const dag = buildCausalityDag(SCENES, [edge("a", "b")]);
    expect(dag.nodes.map((n) => n.sceneId)).toEqual(["a", "b"]);
    // c, d は辺に出てこないのでノードに含めない
  });

  it("2ノードの循環 (A→B→A) を検出する", () => {
    const dag = buildCausalityDag(SCENES, [edge("a", "b"), edge("b", "a")]);
    expect(dag.cycles.length).toBeGreaterThanOrEqual(1);
    const cyc = dag.cycles[0];
    expect(new Set(cyc)).toEqual(new Set(["a", "b"]));
  });

  it("長い循環 (A→B→C→A) を検出する", () => {
    const dag = buildCausalityDag(SCENES, [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ]);
    expect(dag.cycles.length).toBeGreaterThanOrEqual(1);
    expect(new Set(dag.cycles[0])).toEqual(new Set(["a", "b", "c"]));
  });

  it("循環の無い DAG では cycles は空", () => {
    const dag = buildCausalityDag(SCENES, [
      edge("a", "b"),
      edge("b", "c"),
      edge("a", "c"),
    ]);
    expect(dag.cycles).toEqual([]);
  });

  it("空入力は空の DAG", () => {
    const dag = buildCausalityDag(SCENES, []);
    expect(dag).toEqual({ nodes: [], edges: [], cycles: [] });
  });

  it("辺・ノードは決定的順序 (sceneId 昇順) で返す", () => {
    const dag = buildCausalityDag(SCENES, [edge("c", "d"), edge("a", "b")]);
    expect(dag.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "a->b",
      "c->d",
    ]);
    expect(dag.nodes.map((n) => n.sceneId)).toEqual(["a", "b", "c", "d"]);
  });
});

function ann(
  sceneId: string | null,
  category: string,
  meta: Record<string, unknown>,
): CausalAnnotationInput {
  return { sceneId, category, metadata: JSON.stringify(meta) };
}

describe("extractCausalEdges", () => {
  it("timeline_anchor かつ relation=causality のみ cause→effect を取り出す", () => {
    const edges = extractCausalEdges([
      ann("b", "timeline_anchor", {
        relation: "causality",
        cause_scene_id: "a",
        llm_reason: "A が原因",
      }),
    ]);
    expect(edges).toEqual([
      { causeSceneId: "a", effectSceneId: "b", reason: "A が原因" },
    ]);
  });

  it("timeline_anchor 以外は無視する", () => {
    const edges = extractCausalEdges([
      ann("b", "consistency_anchor", {
        relation: "causality",
        cause_scene_id: "a",
      }),
    ]);
    expect(edges).toEqual([]);
  });

  it("relation が causality 以外 (chronology 等) は無視する", () => {
    const edges = extractCausalEdges([
      ann("b", "timeline_anchor", {
        relation: "chronology",
        cause_scene_id: "a",
      }),
    ]);
    expect(edges).toEqual([]);
  });

  it("cause_scene_id 欠落は null として返す (DAG builder 側で捨てる)", () => {
    const edges = extractCausalEdges([
      ann("b", "timeline_anchor", { relation: "causality" }),
    ]);
    expect(edges).toEqual([
      { causeSceneId: null, effectSceneId: "b", reason: undefined },
    ]);
  });

  it("壊れた metadata JSON は飛ばす", () => {
    const edges = extractCausalEdges([
      { sceneId: "b", category: "timeline_anchor", metadata: "{not json" },
      ann("c", "timeline_anchor", {
        relation: "causality",
        cause_scene_id: "a",
      }),
    ]);
    expect(edges).toEqual([
      { causeSceneId: "a", effectSceneId: "c", reason: undefined },
    ]);
  });
});
