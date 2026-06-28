/**
 * TS↔Rust chronicle snapshot parity gate.
 *
 * The fixtures under `fixtures/chronicle-snapshot/*.json` are shared with the
 * Rust suite in `grimodex-mcp` (`chronicle_snapshot::tests`). Each fixture's
 * `input` is run through the full derive pipeline (resolveSceneAnchor →
 * pickSnapshotCharacters → deriveChronicleSnapshot) and must equal `expected`.
 * Both languages read the same JSON, so any drift in either derive breaks CI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import {
  deriveChronicleSnapshot,
  pickSnapshotCharacters,
  type ChronicleSnapshot,
} from "./chronicleSnapshot";
import { resolveSceneAnchor, type SceneChronicle } from "./resolveSceneAnchor";
import type {
  EventRow,
  ParticipantRow,
  EventRelationRow,
  SceneEventRow,
} from "./api";
import type { ChronicleCalendar } from "./chronicleTime";
import type { EventPrecision } from "@/db/schema";

interface FixtureInput {
  sceneId: string;
  nodes: Partial<TreeNodeData>[];
  events: EventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  sceneEvents: SceneEventRow[];
  calendar: ChronicleCalendar | null;
  codexNames: Record<string, string>;
  /** formattedDate ロケール（既定 ja）。Rust AssembleInput.lang と対称。 */
  lang?: string;
}

interface Fixture {
  name: string;
  input: FixtureInput;
  expected: ChronicleSnapshot;
}

function runPipeline(input: FixtureInput): ChronicleSnapshot {
  const readingOrder = computeGlobalSceneOrder(input.nodes as TreeNodeData[]);
  // scene-own アンカー源: input.nodes の scene ノードから暦日付を構築（push と同じ）。
  const sceneChronicle = new Map<string, SceneChronicle>();
  for (const n of input.nodes) {
    if (n.nodeType !== "scene" || !n.id) continue;
    sceneChronicle.set(n.id, {
      startTime: n.chronicleStartTime ?? null,
      startMinute: n.chronicleStartMinute ?? null,
      startGranularity: n.chronicleStartGranularity ?? "none",
      precision: (n.chroniclePrecision ?? "exact") as EventPrecision,
    });
  }
  const anchor = resolveSceneAnchor(input.sceneId, {
    sceneEvents: input.sceneEvents,
    events: input.events,
    readingOrder,
    sceneChronicle,
  });
  const characterIds = pickSnapshotCharacters({
    anchor,
    events: input.events,
    participants: input.participants,
  });
  return deriveChronicleSnapshot(
    {
      anchor,
      events: input.events,
      participants: input.participants,
      relations: input.relations,
      sceneEvents: input.sceneEvents,
      calendar: input.calendar,
      characterIds,
      codexNames: new Map(Object.entries(input.codexNames)),
    },
    input.lang ?? "ja",
  );
}

const fixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "chronicle-snapshot",
);
const fixtureFiles = readdirSync(fixturesDir).filter((f) =>
  f.endsWith(".json"),
);

describe("chronicle snapshot fixtures (TS derive)", () => {
  it("ships at least 3 fixtures", () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(3);
  });

  for (const file of fixtureFiles) {
    const fixture: Fixture = JSON.parse(
      readFileSync(join(fixturesDir, file), "utf8"),
    );
    it(`${file}: ${fixture.name}`, () => {
      expect(runPipeline(fixture.input)).toEqual(fixture.expected);
    });
  }
});
