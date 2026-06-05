import { describe, it, expect } from "vitest";
import {
  deriveBlockers,
  totalBlockerCount,
  type BlockerInput,
  type BlockerSceneSignal,
} from "./deriveBlockers";

function scene(
  id: string,
  overrides: Partial<BlockerSceneSignal> = {},
): BlockerSceneSignal {
  return {
    id,
    title: `Scene ${id}`,
    intent: "ある狙い",
    isLoose: false,
    hasUnplacedBeats: false,
    lens: null,
    ...overrides,
  };
}

const EMPTY: BlockerInput = {
  foreshadows: [],
  scenes: [],
  salvageableTrash: [],
};

describe("deriveBlockers", () => {
  it("returns no groups for empty input", () => {
    expect(deriveBlockers(EMPTY)).toEqual([]);
  });

  it("omits empty groups", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      foreshadows: [{ id: "f1", title: "鍵", label: "abandoned" }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe("foreshadow_abandoned");
  });

  it("ranks critical before warning before info", () => {
    const groups = deriveBlockers({
      foreshadows: [
        { id: "f1", title: "弱い伏線", label: "critical_weak" },
        { id: "f2", title: "孤児回収", label: "orphan_payoff" },
        { id: "f3", title: "放棄", label: "abandoned" },
      ],
      scenes: [],
      salvageableTrash: [],
    });
    expect(groups.map((g) => g.severity)).toEqual([
      "critical",
      "warning",
      "info",
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "foreshadow_critical_weak",
      "foreshadow_orphan_payoff",
      "foreshadow_abandoned",
    ]);
  });

  it("treats lens=null (never analyzed) as neither severe nor stale", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      scenes: [scene("s1", { lens: null })],
    });
    // intent is non-empty, no signals at all -> no groups
    expect(groups).toEqual([]);
  });

  it("classifies severe diagnostics as critical when any error is present", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      scenes: [
        scene("s1", { lens: { worst: "error", stale: false } }),
        scene("s2", { lens: { worst: "warning", stale: false } }),
      ],
    });
    const severe = groups.find((g) => g.kind === "diagnostic_severe");
    expect(severe?.severity).toBe("critical");
    expect(severe?.entries.map((e) => e.id).sort()).toEqual(["s1", "s2"]);
    // entries carry sceneId for navigation
    expect(severe?.entries[0].sceneId).toBe(severe?.entries[0].id);
  });

  it("classifies severe diagnostics as warning when only warnings present", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      scenes: [scene("s1", { lens: { worst: "warning", stale: false } })],
    });
    expect(groups.find((g) => g.kind === "diagnostic_severe")?.severity).toBe(
      "warning",
    );
  });

  it("surfaces stale diagnostics independently of severity", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      // suggestion is not severe, but it is stale -> stale group only
      scenes: [scene("s1", { lens: { worst: "suggestion", stale: true } })],
    });
    expect(groups.map((g) => g.kind)).toEqual(["diagnostic_stale"]);
  });

  it("detects unplaced beats, loose scenes, and empty intent", () => {
    const groups = deriveBlockers({
      ...EMPTY,
      scenes: [
        scene("s1", { hasUnplacedBeats: true }),
        scene("s2", { isLoose: true }),
        scene("s3", { intent: "   " }),
        scene("s4", { intent: null }),
      ],
    });
    const byKind = new Map(groups.map((g) => [g.kind, g]));
    expect(
      byKind.get("scene_unplaced_beats")?.entries.map((e) => e.id),
    ).toEqual(["s1"]);
    expect(byKind.get("scene_loose")?.entries.map((e) => e.id)).toEqual(["s2"]);
    expect(
      byKind
        .get("scene_intent_empty")
        ?.entries.map((e) => e.id)
        .sort(),
    ).toEqual(["s3", "s4"]);
  });

  it("includes salvageable trash as the lowest-priority info group", () => {
    const groups = deriveBlockers({
      foreshadows: [{ id: "f1", title: "弱", label: "critical_weak" }],
      scenes: [],
      salvageableTrash: [{ id: "t1", label: "消えた断片" }],
    });
    expect(groups[groups.length - 1].kind).toBe("trash_salvageable");
  });

  it("totalBlockerCount sums all entries across groups", () => {
    const groups = deriveBlockers({
      foreshadows: [
        { id: "f1", title: "a", label: "critical_weak" },
        { id: "f2", title: "b", label: "orphan_payoff" },
      ],
      scenes: [scene("s1", { isLoose: true })],
      salvageableTrash: [],
    });
    expect(totalBlockerCount(groups)).toBe(3);
  });
});
