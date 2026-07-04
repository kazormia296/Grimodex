import { describe, it, expect } from "vitest";
import {
  buildGalaxyGraph,
  applyGalaxyFilters,
  type GalaxyGraphInput,
} from "./galaxyGraph";
import { DEFAULT_GALAXY_FILTERS } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CrossReferenceEntry } from "@/features/codex/crossReference";
import type { CodexRelationRow } from "@/features/codex/codexRelationApi";
import type {
  EventRow,
  SceneEventRow,
  ParticipantRow,
} from "@/features/chronicle/api";
import type {
  PlotThreadRow,
  PlotThreadLinkRow,
} from "@/features/plot-threads/api";

function scene(id: string, title: string, sortOrder: string): TreeNodeData {
  return {
    id,
    parentId: null,
    nodeType: "scene",
    title,
    sortOrder,
  } as TreeNodeData;
}

function xref(
  entryId: string,
  entryName: string,
  entryType: string,
  sceneIds: string[],
): CrossReferenceEntry {
  return {
    entryId,
    entryName,
    entryType,
    scenes: sceneIds.map((sceneId) => ({
      sceneId,
      sceneTitle: sceneId,
      count: 1,
    })),
  };
}

/**
 * 標準 fixture:
 * シーン s1→s2（読み順）、codex c1(character)/c2(location)、event e1、thread t1
 * mention: s1-c1, s2-c1, s2-c2 / relation: c1-c2 "宿敵"
 * eventLink: s1-e1 / participant: e1-c1 / thread: t1-s1, t1-s2
 */
function fixtureInput(): GalaxyGraphInput {
  return {
    treeNodes: [scene("s1", "シーン1", "a"), scene("s2", "シーン2", "b")],
    crossReference: [
      xref("c1", "アリス", "character", ["s1", "s2"]),
      xref("c2", "王都", "location", ["s2"]),
    ],
    relations: [
      { fromCodexId: "c1", toCodexId: "c2", label: "宿敵" } as CodexRelationRow,
    ],
    events: [{ id: "e1", title: "開戦" } as EventRow],
    sceneEvents: [{ sceneId: "s1", eventId: "e1" } as SceneEventRow],
    participants: [{ eventId: "e1", codexEntryId: "c1" } as ParticipantRow],
    threads: [{ id: "t1", name: "主軸", color: "#ff0000" } as PlotThreadRow],
    threadLinks: [
      { threadId: "t1", nodeId: "s1" } as PlotThreadLinkRow,
      { threadId: "t1", nodeId: "s2" } as PlotThreadLinkRow,
    ],
  };
}

function linkKinds(graph: ReturnType<typeof buildGalaxyGraph>) {
  return graph.links.map((l) => `${l.kind}:${l.source}->${l.target}`).sort();
}

describe("buildGalaxyGraph", () => {
  it("全種別のノードを namespaced id で生成する", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([
      "codex:c1",
      "codex:c2",
      "event:e1",
      "scene:s1",
      "scene:s2",
      "thread:t1",
    ]);
    const c1 = graph.nodes.find((n) => n.id === "codex:c1")!;
    expect(c1.kind).toBe("codex");
    expect(c1.refId).toBe("c1");
    expect(c1.label).toBe("アリス");
    expect(c1.typeSlug).toBe("character");
    const t1 = graph.nodes.find((n) => n.id === "thread:t1")!;
    expect(t1.color).toBe("#ff0000");
    expect(t1.label).toBe("主軸");
  });

  it("読み順で隣接シーンに sequence エッジを張る", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    expect(linkKinds(graph)).toContain("sequence:scene:s1->scene:s2");
  });

  it("mention/relation/eventLink/participant/thread エッジを張り、relation は label を保持する", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const kinds = linkKinds(graph);
    expect(kinds).toContain("mention:scene:s1->codex:c1");
    expect(kinds).toContain("mention:scene:s2->codex:c1");
    expect(kinds).toContain("mention:scene:s2->codex:c2");
    expect(kinds).toContain("relation:codex:c1->codex:c2");
    expect(kinds).toContain("eventLink:scene:s1->event:e1");
    expect(kinds).toContain("participant:event:e1->codex:c1");
    expect(kinds).toContain("thread:thread:t1->scene:s1");
    expect(kinds).toContain("thread:thread:t1->scene:s2");
    const rel = graph.links.find((l) => l.kind === "relation")!;
    expect(rel.label).toBe("宿敵");
    const mention = graph.links.find((l) => l.kind === "mention")!;
    expect(mention.label).toBeNull();
  });

  it("片端が存在しないエッジは捨てる", () => {
    const input = fixtureInput();
    input.relations.push({
      fromCodexId: "c1",
      toCodexId: "ghost",
      label: "幽霊",
    } as CodexRelationRow);
    input.sceneEvents.push({
      sceneId: "ghost-scene",
      eventId: "e1",
    } as SceneEventRow);
    const graph = buildGalaxyGraph(input);
    expect(
      graph.links.filter(
        (l) => l.source.includes("ghost") || l.target.includes("ghost"),
      ),
    ).toEqual([]);
  });

  it("重複する mention は 1 本に dedup される", () => {
    const input = fixtureInput();
    // c1 の s1 言及を二重に入れる
    input.crossReference[0].scenes.push({
      sceneId: "s1",
      sceneTitle: "s1",
      count: 3,
    });
    const graph = buildGalaxyGraph(input);
    const s1c1 = graph.links.filter(
      (l) =>
        l.kind === "mention" &&
        l.source === "scene:s1" &&
        l.target === "codex:c1",
    );
    expect(s1c1).toHaveLength(1);
  });

  it("言及ゼロの codex エントリもノードになる", () => {
    const input = fixtureInput();
    input.crossReference.push(xref("c3", "無名", "item", []));
    const graph = buildGalaxyGraph(input);
    expect(graph.nodes.some((n) => n.id === "codex:c3")).toBe(true);
  });
});

describe("applyGalaxyFilters", () => {
  it("ノード種別 OFF でノードと接続エッジが消える", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const filtered = applyGalaxyFilters(graph, {
      ...DEFAULT_GALAXY_FILTERS,
      nodes: { ...DEFAULT_GALAXY_FILTERS.nodes, codex: false },
    });
    expect(filtered.nodes.some((n) => n.kind === "codex")).toBe(false);
    expect(
      filtered.links.some(
        (l) =>
          l.kind === "mention" ||
          l.kind === "relation" ||
          l.kind === "participant",
      ),
    ).toBe(false);
    // シーン系エッジは残る
    expect(filtered.links.some((l) => l.kind === "sequence")).toBe(true);
  });

  it("エッジ種別 OFF でエッジだけ消える", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const filtered = applyGalaxyFilters(graph, {
      ...DEFAULT_GALAXY_FILTERS,
      edges: { ...DEFAULT_GALAXY_FILTERS.edges, sequence: false },
    });
    expect(filtered.links.some((l) => l.kind === "sequence")).toBe(false);
    expect(filtered.nodes.some((n) => n.kind === "scene")).toBe(true);
  });

  it("hideOrphans でフィルタ後次数 0 のノードが消える", () => {
    const input = fixtureInput();
    input.crossReference.push(xref("c3", "無名", "item", []));
    const graph = buildGalaxyGraph(input);
    const filtered = applyGalaxyFilters(graph, {
      ...DEFAULT_GALAXY_FILTERS,
      hideOrphans: true,
    });
    expect(filtered.nodes.some((n) => n.id === "codex:c3")).toBe(false);
    expect(filtered.nodes.some((n) => n.id === "codex:c1")).toBe(true);
  });

  it("val は 1 + sqrt(degree) で再計算される", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const filtered = applyGalaxyFilters(graph, DEFAULT_GALAXY_FILTERS);
    // c1 の次数: mention×2 (s1,s2) + relation×1 + participant×1 = 4
    const c1 = filtered.nodes.find((n) => n.id === "codex:c1")!;
    expect(c1.val).toBeCloseTo(1 + Math.sqrt(4));
    // 孤立ノードなし設定でも次数 0 は val 1
    const inputWithOrphan = fixtureInput();
    inputWithOrphan.crossReference.push(xref("c3", "無名", "item", []));
    const filtered2 = applyGalaxyFilters(
      buildGalaxyGraph(inputWithOrphan),
      DEFAULT_GALAXY_FILTERS,
    );
    expect(filtered2.nodes.find((n) => n.id === "codex:c3")!.val).toBe(1);
  });

  it("入力 graph を変異させない", () => {
    const graph = buildGalaxyGraph(fixtureInput());
    const before = JSON.stringify(graph);
    applyGalaxyFilters(graph, {
      ...DEFAULT_GALAXY_FILTERS,
      nodes: { ...DEFAULT_GALAXY_FILTERS.nodes, codex: false },
      hideOrphans: true,
    });
    expect(JSON.stringify(graph)).toBe(before);
  });
});
