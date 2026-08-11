// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { ForeshadowPayoffMark } from "./marks/ForeshadowPayoffMark";
import { ForeshadowSetupMark } from "./marks/ForeshadowSetupMark";
import { saveForeshadowAnchors } from "./saveAnchors";

async function run(
  browser: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await browser.invoke("db_execute", { sql, params, method: "run" });
}

async function query(
  browser: PersistentBrowserMock,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const result = await browser.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params: [], method: "all" },
  );
  return result.rows;
}

describe("browser foreshadow anchor save product journey", () => {
  let browser: PersistentBrowserMock;
  let editor: Editor;

  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).grimodex;
    browser = await createBrowserMock();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) =>
        browser.invoke(command, args),
    );

    await run(
      browser,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('anchor-scene', 'default-project', 'scene', 'Anchor scene', 'a0')`,
    );
    await run(
      browser,
      `INSERT INTO foreshadows
        (id, project_id, title, created_at, updated_at)
       VALUES ('anchor-setup-foreshadow', 'default-project', 'Setup', 1, 1),
              ('anchor-payoff-foreshadow', 'default-project', 'Payoff', 1, 1)`,
    );
    await run(
      browser,
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
         attribution, is_orphan, semantic_key, created_at, updated_at)
       VALUES ('stale-anchor', 'anchor-setup-foreshadow', 'anchor-scene',
               1, 2, 'designated_existing', 'human', 0,
               'anchor-setup-foreshadow|anchor-scene|1|2', 1, 1)`,
    );

    editor = new Editor({
      extensions: [StarterKit, ForeshadowSetupMark, ForeshadowPayoffMark],
      content: "<p>SETUP PAYOFF</p>",
    });
  });

  afterEach(() => {
    editor?.destroy();
    browser?.close();
  });

  it("persists setup/payoff marks and orphans stale anchors through BrowserMock", async () => {
    const transaction = editor.state.tr
      .addMark(
        1,
        6,
        editor.schema.marks.foreshadowSetup.create({
          setupId: "current-anchor",
          foreshadowId: "anchor-setup-foreshadow",
          baseVersion: 0,
        }),
      )
      .addMark(
        7,
        13,
        editor.schema.marks.foreshadowPayoff.create({
          foreshadowId: "anchor-payoff-foreshadow",
          baseVersion: 0,
        }),
      );
    editor.view.dispatch(transaction);

    await saveForeshadowAnchors("anchor-scene", editor.state.doc);

    expect(
      await query(
        browser,
        `SELECT id, foreshadow_id, scene_id, from_pos, to_pos,
                is_orphan, semantic_key
           FROM foreshadow_setups
          WHERE scene_id = 'anchor-scene'
          ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "current-anchor",
        foreshadow_id: "anchor-setup-foreshadow",
        scene_id: "anchor-scene",
        from_pos: 1,
        to_pos: 6,
        is_orphan: 0,
        semantic_key: "anchor-setup-foreshadow|anchor-scene|1|6",
      },
      {
        id: "stale-anchor",
        foreshadow_id: "anchor-setup-foreshadow",
        scene_id: "anchor-scene",
        from_pos: 1,
        to_pos: 2,
        is_orphan: 1,
        semantic_key: "anchor-setup-foreshadow|anchor-scene|1|2",
      },
    ]);
    expect(
      await query(
        browser,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos
           FROM foreshadows WHERE id = 'anchor-payoff-foreshadow'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: "anchor-scene",
        payoff_from_pos: 7,
        payoff_to_pos: 13,
      },
    ]);
  });

  it("coalesces adjacent logical anchors split by rich-text marks", async () => {
    const transaction = editor.state.tr
      .addMark(
        1,
        6,
        editor.schema.marks.foreshadowSetup.create({
          setupId: "split-anchor",
          foreshadowId: "anchor-setup-foreshadow",
          baseVersion: 0,
        }),
      )
      .addMark(2, 4, editor.schema.marks.bold.create())
      .addMark(
        7,
        13,
        editor.schema.marks.foreshadowPayoff.create({
          foreshadowId: "anchor-payoff-foreshadow",
          baseVersion: 0,
        }),
      )
      .addMark(8, 10, editor.schema.marks.italic.create());
    editor.view.dispatch(transaction);

    await saveForeshadowAnchors("anchor-scene", editor.state.doc);

    const call = invokeMock.mock.calls.find(
      ([command]) => command === "foreshadow_save_anchors_for_scene",
    );
    expect(call?.[1]).toMatchObject({
      setups: [
        {
          id: "split-anchor",
          foreshadowId: "anchor-setup-foreshadow",
          baseVersion: 0,
          sceneId: "anchor-scene",
          fromPos: 1,
          toPos: 6,
        },
      ],
      payoffs: [
        {
          foreshadowId: "anchor-payoff-foreshadow",
          baseVersion: 0,
          sceneId: "anchor-scene",
          fromPos: 7,
          toPos: 13,
        },
      ],
      baseVersions: {
        "anchor-setup-foreshadow": 0,
        "anchor-payoff-foreshadow": 0,
      },
    });
    expect(
      await query(
        browser,
        `SELECT id, from_pos, to_pos
           FROM foreshadow_setups
          WHERE id = 'split-anchor'`,
      ),
    ).toEqual([{ id: "split-anchor", from_pos: 1, to_pos: 6 }]);
    expect(
      await query(
        browser,
        `SELECT payoff_from_pos, payoff_to_pos
           FROM foreshadows
          WHERE id = 'anchor-payoff-foreshadow'`,
      ),
    ).toEqual([{ payoff_from_pos: 7, payoff_to_pos: 13 }]);
  });
});
