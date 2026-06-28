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
import { resolveSceneAnchor } from "./resolveSceneAnchor";
import type {
  EventRow,
  ParticipantRow,
  EventRelationRow,
  SceneEventRow,
} from "./api";
import type { ChronicleCalendar } from "./chronicleTime";

interface FixtureInput {
  sceneId: string;
  nodes: Partial<TreeNodeData>[];
  events: EventRow[];
  participants: ParticipantRow[];
  relations: EventRelationRow[];
  sceneEvents: SceneEventRow[];
  calendar: ChronicleCalendar | null;
  codexNames: Record<string, string>;
}

interface Fixture {
  name: string;
  input: FixtureInput;
  expected: ChronicleSnapshot;
}

function runPipeline(input: FixtureInput): ChronicleSnapshot {
  const readingOrder = computeGlobalSceneOrder(input.nodes as TreeNodeData[]);
  const anchor = resolveSceneAnchor(input.sceneId, {
    sceneEvents: input.sceneEvents,
    events: input.events,
    readingOrder,
  });
  const characterIds = pickSnapshotCharacters({
    anchor,
    events: input.events,
    participants: input.participants,
  });
  return deriveChronicleSnapshot({
    anchor,
    events: input.events,
    participants: input.participants,
    relations: input.relations,
    sceneEvents: input.sceneEvents,
    calendar: input.calendar,
    characterIds,
    codexNames: new Map(Object.entries(input.codexNames)),
  });
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
