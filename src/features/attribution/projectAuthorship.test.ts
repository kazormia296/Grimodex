// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbSelectMock } = vi.hoisted(() => ({ dbSelectMock: vi.fn() }));

vi.mock("@/db/client", () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock("./projectStats", () => ({
  loadProjectAttributionStats: vi.fn(),
}));

import { buildProjectAuthorshipReport } from "./projectAuthorship";
import { loadProjectAttributionStats } from "./projectStats";

type ProjectRow = { id: string; title: string };
type NodeRow = {
  id: string;
  parentId: string | null;
  nodeType: "folder" | "scene" | "note";
  title: string;
  sortOrder: string;
  archivedAt: string | null;
};

function setupDb(projectRows: ProjectRow[], nodeRows: NodeRow[]): void {
  // The aggregator calls db.select() twice — first for projects, then for
  // treeNodes. Each chain ends with `.where(...)` returning a Promise.
  let callCount = 0;
  dbSelectMock.mockImplementation(() => {
    callCount += 1;
    const isProjectsQuery = callCount === 1;
    return {
      from: () => ({
        where: () => Promise.resolve(isProjectsQuery ? projectRows : nodeRows),
      }),
    };
  });
}

describe("buildProjectAuthorshipReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rolls up scene stats into chapters and project totals", async () => {
    setupDb(
      [{ id: "p1", title: "My Novel" }],
      [
        {
          id: "ch1",
          parentId: null,
          nodeType: "folder",
          title: "Chapter 1",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "ch2",
          parentId: null,
          nodeType: "folder",
          title: "Chapter 2",
          sortOrder: "a1",
          archivedAt: null,
        },
        {
          id: "s1",
          parentId: "ch1",
          nodeType: "scene",
          title: "Scene 1",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "s2",
          parentId: "ch1",
          nodeType: "scene",
          title: "Scene 2",
          sortOrder: "a1",
          archivedAt: null,
        },
        {
          id: "s3",
          parentId: "ch2",
          nodeType: "scene",
          title: "Scene 3",
          sortOrder: "a0",
          archivedAt: null,
        },
        // Note must be excluded
        {
          id: "n1",
          parentId: "ch1",
          nodeType: "note",
          title: "Cast notes",
          sortOrder: "a2",
          archivedAt: null,
        },
      ],
    );
    vi.mocked(loadProjectAttributionStats).mockResolvedValue({
      s1: {
        human: 80,
        ai: 10,
        unknown: 0,
        unmarked: 10,
        total: 100,
        modelBreakdown: {},
      },
      s2: {
        human: 200,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 200,
        modelBreakdown: {},
      },
      s3: {
        human: 50,
        ai: 50,
        unknown: 0,
        unmarked: 0,
        total: 100,
        modelBreakdown: {},
      },
    });

    const report = await buildProjectAuthorshipReport("p1");

    expect(report.projectId).toBe("p1");
    expect(report.projectTitle).toBe("My Novel");
    expect(report.scope).toBe("body-text-only");
    expect(report.unparentedScenes).toEqual([]);

    expect(report.chapters).toHaveLength(2);
    const [ch1, ch2] = report.chapters;
    expect(ch1.id).toBe("ch1");
    expect(ch1.scenes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(ch1.totals).toEqual({
      human: 280,
      ai: 10,
      unknown: 0,
      unmarked: 10,
      total: 300,
      humanRatio: 290 / 300,
    });
    expect(ch2.scenes.map((s) => s.id)).toEqual(["s3"]);

    expect(report.totals.total).toBe(400);
    expect(report.totals.ai).toBe(60);
    expect(report.totals.humanRatio).toBeCloseTo(340 / 400, 6);
  });

  it("excludes notes and archived nodes from the rollup", async () => {
    setupDb(
      [{ id: "p1", title: "P" }],
      [
        {
          id: "ch1",
          parentId: null,
          nodeType: "folder",
          title: "Ch",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "alive",
          parentId: "ch1",
          nodeType: "scene",
          title: "Alive",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "dead",
          parentId: "ch1",
          nodeType: "scene",
          title: "Archived",
          sortOrder: "a1",
          archivedAt: "2026-01-01T00:00:00Z",
        },
      ],
    );
    vi.mocked(loadProjectAttributionStats).mockResolvedValue({
      alive: {
        human: 100,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 100,
        modelBreakdown: {},
      },
    });

    const report = await buildProjectAuthorshipReport("p1");
    const sceneIdsCalled = vi.mocked(loadProjectAttributionStats).mock
      .calls[0][0];
    expect(sceneIdsCalled).toEqual(["alive"]);
    expect(report.totals.total).toBe(100);
    expect(report.chapters[0].scenes).toHaveLength(1);
  });

  it("collects scenes with no folder parent into unparentedScenes", async () => {
    setupDb(
      [{ id: "p1", title: "P" }],
      [
        {
          id: "loose",
          parentId: null,
          nodeType: "scene",
          title: "Loose",
          sortOrder: "a0",
          archivedAt: null,
        },
      ],
    );
    vi.mocked(loadProjectAttributionStats).mockResolvedValue({
      loose: {
        human: 40,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 40,
        modelBreakdown: {},
      },
    });

    const report = await buildProjectAuthorshipReport("p1");
    expect(report.chapters).toEqual([]);
    expect(report.unparentedScenes).toHaveLength(1);
    expect(report.totals.total).toBe(40);
  });

  it("rolls scenes under their topmost folder for Act > Chapter > Scene depth", async () => {
    setupDb(
      [{ id: "p1", title: "Deep" }],
      [
        {
          id: "act",
          parentId: null,
          nodeType: "folder",
          title: "Act I",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "chap",
          parentId: "act",
          nodeType: "folder",
          title: "Chapter 1",
          sortOrder: "a0",
          archivedAt: null,
        },
        {
          id: "scn",
          parentId: "chap",
          nodeType: "scene",
          title: "Scene 1",
          sortOrder: "a0",
          archivedAt: null,
        },
      ],
    );
    vi.mocked(loadProjectAttributionStats).mockResolvedValue({
      scn: {
        human: 100,
        ai: 0,
        unknown: 0,
        unmarked: 0,
        total: 100,
        modelBreakdown: {},
      },
    });

    const report = await buildProjectAuthorshipReport("p1");
    expect(report.chapters).toHaveLength(1);
    expect(report.chapters[0].id).toBe("act");
    expect(report.chapters[0].scenes.map((s) => s.id)).toEqual(["scn"]);
    expect(report.totals.total).toBe(100);
  });

  it("produces a zero report when the project has no scenes", async () => {
    setupDb([{ id: "p1", title: "Empty" }], []);
    vi.mocked(loadProjectAttributionStats).mockResolvedValue({});

    const report = await buildProjectAuthorshipReport("p1");
    expect(report.totals.total).toBe(0);
    expect(report.totals.humanRatio).toBe(0);
    expect(report.chapters).toEqual([]);
  });
});
