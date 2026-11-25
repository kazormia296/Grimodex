/**
 * TS↔Rust chronicle snapshot parity gate.
 *
 * The fixtures under `fixtures/chronicle-snapshot/*.json` are shared with the
 * Rust suite in `grimodex-mcp` (`chronicle_snapshot::tests`). Each fixture's
 * `input` is run through the full derive pipeline (resolveSnapshotSceneAnchor →
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
import { resolveSnapshotSceneAnchor } from "@/../electron/shared/readDomain/features/chronicle/chronicleAnchorByDate";
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
  revealNodes?: Partial<TreeNodeData>[];
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
  const revealNodes = (input.revealNodes ?? input.nodes).filter(
    (node) => node.nodeType === "scene" && node.id && node.archivedAt == null,
  );
  const revealNodeIds = new Set(revealNodes.map((node) => node.id));
  const revealReadingOrder = new Map(
    [...computeGlobalSceneOrder(revealNodes as TreeNodeData[])].filter(([id]) =>
      revealNodeIds.has(id),
    ),
  );
  const anchor = resolveSnapshotSceneAnchor(input.sceneId, {
    ...input,
    nodes: input.nodes as TreeNodeData[],
    readingOrder,
  });
  const characterIds = pickSnapshotCharacters({ ...input, anchor });
  return deriveChronicleSnapshot(
    {
      anchor,
      sceneId: input.sceneId,
      events: input.events,
      participants: input.participants,
      relations: input.relations,
      sceneEvents: input.sceneEvents,
      calendar: input.calendar,
      characterIds,
      codexNames: new Map(Object.entries(input.codexNames)),
      revealSceneView: {
        nodes: revealNodes.map((node) => ({
          id: node.id!,
          title: node.title ?? "",
        })),
        currentSceneId: input.sceneId,
        readingOrder: revealReadingOrder,
      },
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

  it("C3a and proxy ignore dated scenes and links inside archived branches", () => {
    const basis: Fixture = JSON.parse(
      readFileSync(join(fixturesDir, "02-proxy-no-calendar.json"), "utf8"),
    );
    const row = { ...basis.input.events[0], startGranularity: "day" as const };
    const archived = {
      id: "archived",
      parentId: null,
      sortOrder: "a0G",
      archivedAt: "2026-01-01",
      chronicleStartTime: 200,
      chronicleStartGranularity: "day" as const,
    };
    const world: FixtureInput = {
      ...basis.input,
      events: [row],
      nodes: [
        ...basis.input.nodes,
        { ...archived, nodeType: "folder" },
        {
          ...archived,
          id: "child",
          archivedAt: null,
          parentId: "archived",
          nodeType: "scene",
        },
        { ...archived, id: "archived-scene", nodeType: "scene" },
      ],
      sceneEvents: [
        ...basis.input.sceneEvents,
        { sceneId: "child", eventId: row.id },
        { sceneId: "archived-scene", eventId: row.id },
      ],
    };
    expect(runPipeline(world).time).toMatchObject({
      source: "proxy",
      startTime: 100,
      precision: "unknown",
    });
    expect(runPipeline(world).recentEvents.map((e) => e.eventId)).toEqual([
      row.id,
    ]);
    for (const sceneId of ["child", "archived-scene"])
      expect(runPipeline({ ...world, sceneId }).time.source).toBe("none");
    expect(
      runPipeline({
        ...world,
        events: [row, { ...row, id: "unlinked", precision: "approx" }],
      }).time.source,
    ).toBe("none");
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
