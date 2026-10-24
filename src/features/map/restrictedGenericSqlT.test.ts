// @vitest-environment happy-dom
import { writeFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { restrictedGenericSql } from "@/lib/d2aRestrictedGenericSql.testSupport";

// DA-2b T (D-12 (a), K3/2 "chat の書込みの入口" 11; DR-DA2-52, DR-DA2B-R4):
// Map (sticky included), Label, Prompt template and the pin's children toggle
// write tables outside the D2a table ledger, so their plain DML passes while
// restricted and only RETURNING is refused. Each function runs here against a
// real SQLite in the restricted generic-SQL shape, sends no RETURNING, and
// answers the row it wrote (read back by the id it already holds). The Codex
// visibility baseline (read-open) uses the typed CAS writer instead.
//
// `D2B_T_SQL_SHAPES_OUT=<file>` writes every statement these functions send,
// for the restricted run of ST5 (the shapes replayed against real Native).

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: vi.fn(() => "t-session"),
  recordChangeEvent: vi.fn(),
}));

import {
  adoptSticky,
  createBoard,
  createFrame,
  createSticky,
  createUserEdge,
  getOrCreateBoard,
  renameBoard,
  updateFrame,
  updateMapBoardSettings,
  updateNodePosition,
  updateSticky,
  updateUserEdge,
  upsertNodePosition,
} from "./mapApi";
import { createLabel, updateLabel } from "@/features/labels/labelApi";
import {
  createPromptTemplate,
  updatePromptTemplate,
} from "@/features/prompt-library/api";
import { togglePinChildren } from "@/features/chat/chatApi";
import { markImpactBaselinePhasesRestricted } from "@/features/codex/impactBaselineVisibility";

const PROJECT = "default-project";
const shapes: Array<{ fn: string; sql: string; params: unknown[] }> = [];
let current = "";
let browser: PersistentBrowserMock;

async function row(table: string, id: string, key = "id") {
  const result = await browser.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    {
      sql: `SELECT * FROM ${table} WHERE ${key} = ?`,
      params: [id],
      method: "all",
    },
  );
  return result.rows[0];
}

function camel(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      value,
    ]),
  );
}

async function step<T>(fn: string, run: () => Promise<T>): Promise<T> {
  current = fn;
  try {
    return await run();
  } finally {
    current = "";
  }
}

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  browser = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    restrictedGenericSql((command: string, args?: Record<string, unknown>) => {
      if (current && command === "db_execute") {
        shapes.push({
          fn: current,
          sql: String(args?.sql),
          params: (args?.params as unknown[]) ?? [],
        });
      }
      return browser.invoke(command, args);
    }),
  );
});

afterEach(() => {
  browser.close();
});

afterAll(() => {
  const out = process.env.D2B_T_SQL_SHAPES_OUT;
  if (out) writeFileSync(out, JSON.stringify(shapes, null, 1));
});

function returningSent(): string[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === "db_execute")
    .map(([, args]) => String((args as { sql: string }).sql))
    .filter((sql) => /\breturning\b/i.test(sql));
}

describe("T: RETURNING-free writes answer the written row while restricted", () => {
  it("boards, node positions, stickies, edges and frames", async () => {
    const main = await step("getOrCreateBoard", () =>
      getOrCreateBoard(PROJECT),
    );
    expect(main).toEqual(camel(await row("map_boards", main.id)));
    const board = await step("createBoard", () => createBoard(PROJECT, "B"));
    expect(board).toEqual(camel(await row("map_boards", board.id)));
    const renamed = await step("renameBoard", () => renameBoard(board.id, "C"));
    expect(renamed).toEqual(camel(await row("map_boards", board.id)));
    expect(renamed?.title).toBe("C");
    const settings = await step("updateMapBoardSettings", () =>
      updateMapBoardSettings(board.id, { mode: "theme", viewportZoom: 2 }),
    );
    expect(settings).toEqual(camel(await row("map_boards", board.id)));
    await expect(
      updateMapBoardSettings("missing", { mode: "free" }),
    ).resolves.toBeUndefined();

    const { sticky, position } = await step("createSticky", () =>
      createSticky({ boardId: board.id, x: 1, y: 2, title: "S" }),
    );
    expect(sticky).toEqual(camel(await row("map_stickies", sticky.id)));
    expect(position).toEqual(
      camel(await row("map_node_positions", position.id)),
    );
    const moved = await step("upsertNodePosition(update)", () =>
      upsertNodePosition({
        boardId: board.id,
        nodeRefType: "sticky",
        stickyId: sticky.id,
        x: 5,
        y: 6,
      }),
    );
    expect(moved).toEqual(camel(await row("map_node_positions", position.id)));
    expect([moved.x, moved.y]).toEqual([5, 6]);
    const pinned = await step("updateNodePosition", () =>
      updateNodePosition(position.id, { pinned: 1 }),
    );
    expect(pinned?.pinned).toBe(1);
    const edited = await step("updateSticky", () =>
      updateSticky(sticky.id, { colorSlot: 3, title: "T" }),
    );
    expect(edited).toEqual(camel(await row("map_stickies", sticky.id)));
    const adopted = await step("adoptSticky", () => adoptSticky(sticky.id));
    expect(adopted.sticky).toEqual(camel(await row("map_stickies", sticky.id)));

    // createSticky's own position is the insert branch of upsertNodePosition.
    const { position: other } = await step("createSticky(second)", () =>
      createSticky({ boardId: board.id, x: 9, y: 9, id: "s2" }),
    );
    expect(other).toEqual(camel(await row("map_node_positions", other.id)));
    const edge = await step("createUserEdge", () =>
      createUserEdge({
        boardId: board.id,
        fromPositionId: position.id,
        toPositionId: other.id,
        forwardLabel: "f",
      }),
    );
    expect(edge).toEqual(camel(await row("map_edges", edge.id)));
    const edge2 = await step("updateUserEdge", () =>
      updateUserEdge(edge.id, { style: "dashed" }),
    );
    expect(edge2?.style).toBe("dashed");

    const frame = await step("createFrame", () =>
      createFrame({ boardId: board.id, x: 0, y: 0, width: 10, height: 10 }),
    );
    expect(frame).toEqual(camel(await row("map_frames", frame.id)));
    const frame2 = await step("updateFrame", () =>
      updateFrame(frame.id, { title: "F2" }),
    );
    expect(frame2).toEqual(camel(await row("map_frames", frame.id)));

    expect(returningSent()).toEqual([]);
  });

  it("labels and prompt templates", async () => {
    const label = await step("createLabel", () =>
      createLabel({ id: "l1", projectId: PROJECT, name: "L", color: "red" }),
    );
    expect(label).toEqual(camel(await row("labels", "l1")));
    const label2 = await step("updateLabel", () =>
      updateLabel("l1", { name: "L2" }),
    );
    expect(label2?.name).toBe("L2");

    const tpl = await step("createPromptTemplate", () =>
      createPromptTemplate({
        id: "t1",
        projectId: PROJECT,
        title: "T",
        content: "C",
      }),
    );
    expect(tpl).toEqual(camel(await row("prompt_templates", "t1")));
    const tpl2 = await step("updatePromptTemplate", () =>
      updatePromptTemplate(PROJECT, "t1", { title: "T2" }),
    );
    expect(tpl2?.title).toBe("T2");
    // A different project's id still matches nothing, as before.
    await expect(
      updatePromptTemplate("other", "t1", { title: "X" }),
    ).resolves.toBeUndefined();
    expect(returningSent()).toEqual([]);
  });

  it("toggles a pin's children and warns when no pin matched", async () => {
    const run = (sql: string) =>
      browser.invoke("db_execute", { sql, params: [], method: "run" });
    await run(
      "INSERT INTO chat_sessions (id, project_id) VALUES ('s1', 'default-project')",
    );
    await run(
      "INSERT INTO codex_entries (id, project_id, type, name) VALUES ('c1', 'default-project', 'character', 'C')",
    );
    await run(
      "INSERT INTO chat_session_pinned_codex (id, session_id, codex_entry_id, with_children, pin_source) VALUES ('p1', 's1', 'c1', 0, 'manual')",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await step("togglePinChildren", () => togglePinChildren("s1", "c1", true));
    expect((await row("chat_session_pinned_codex", "p1")).with_children).toBe(
      1,
    );
    expect(warn).not.toHaveBeenCalled();
    await togglePinChildren("s1", "missing", true);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(returningSent()).toEqual([]);
  });

  it("updates the Codex visibility baseline with the typed CAS writer", async () => {
    const run = (sql: string, params: unknown[] = []) =>
      browser.invoke("db_execute", { sql, params, method: "run" });
    await run(
      "INSERT INTO codex_entries (id, project_id, type, name) VALUES ('c1', 'default-project', 'character', 'C')",
    );
    const snapshot = JSON.stringify({ allPhaseIds: ["ph1"], keep: 1 });
    await run(
      "INSERT INTO impact_review_baselines (entry_id, project_id, snapshot_json, content_hash, reviewed_at) VALUES ('c1', 'default-project', ?, 'h0', '2026-01-01')",
      [snapshot],
    );
    await markImpactBaselinePhasesRestricted("c1");
    const typed = invokeMock.mock.calls.filter(
      ([command]) => command === "impact_review_baseline_update_visibility",
    );
    expect(typed).toEqual([
      [
        "impact_review_baseline_update_visibility",
        {
          payload: {
            projectId: "default-project",
            entryId: "c1",
            expectedContentHash: "h0",
            snapshotJson:
              '{"allPhaseIds":["ph1"],"keep":1,"restrictedPhaseIds":["ph1"],"visibleDeletedPhaseIds":[]}',
            contentHash: expect.stringMatching(/^[0-9a-f]{8}$/),
          },
        },
      ],
    ]);
    const stored = await row("impact_review_baselines", "c1", "entry_id");
    expect(JSON.parse(String(stored.snapshot_json))).toEqual({
      allPhaseIds: ["ph1"],
      keep: 1,
      restrictedPhaseIds: ["ph1"],
      visibleDeletedPhaseIds: [],
    });
    expect(stored.reviewed_at).toBe("2026-01-01");
  });
});
