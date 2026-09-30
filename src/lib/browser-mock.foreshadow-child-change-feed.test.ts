// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

type InvokeArgs = Record<string, unknown>;

interface ForeshadowChildScenario {
  name: string;
  command: string;
  operation: string;
  args: (requestId: string, projectId?: string) => InvokeArgs;
  conflictArgs: (requestId: string) => InvokeArgs;
}

function identity(requestId: string, projectId = "default-project") {
  return {
    projectId,
    requestId,
    sessionId: `session:${requestId}`,
    eventUid: `event:${requestId}`,
    origin: "human" as const,
    originalTransactionId: null,
  };
}

function retryArgs(args: InvokeArgs): InvokeArgs {
  const key = Object.hasOwn(args, "payload")
    ? "payload"
    : Object.hasOwn(args, "patch")
      ? "patch"
      : null;
  const target = key
    ? ({ ...(args[key] as Record<string, unknown>) } as Record<string, unknown>)
    : { ...args };
  target.sessionId = `${String(target.sessionId)}:retry`;
  target.eventUid = `${String(target.eventUid)}:retry`;
  return key ? { ...args, [key]: target } : target;
}

function maintenanceTransactionIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap(maintenanceTransactionIds))];
  }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const ids =
    typeof record.maintenanceTransactionId === "string"
      ? [record.maintenanceTransactionId]
      : [];
  if (Object.hasOwn(record, "foreshadow")) {
    ids.push(...maintenanceTransactionIds(record.foreshadow));
  }
  return [...new Set(ids)];
}

function anchorArgs(
  requestId: string,
  projectId = "default-project",
  firstToPos = 4,
): InvokeArgs {
  return {
    payload: {
      ...identity(requestId, projectId),
      sceneId: "child-anchor-scene",
      setups: [
        {
          id: "child-anchor-a-setup",
          foreshadowId: "child-anchor-a-root",
          baseVersion: 0,
          sceneId: "child-anchor-scene",
          fromPos: 2,
          toPos: firstToPos,
        },
        {
          id: "child-anchor-z-setup",
          foreshadowId: "child-anchor-z-root",
          baseVersion: 0,
          sceneId: "child-anchor-scene",
          fromPos: 6,
          toPos: 8,
        },
      ],
      payoffs: [],
      baseVersions: {
        "child-anchor-a-root": 0,
        "child-anchor-z-root": 0,
      },
      docContentSize: 20,
    },
  };
}

const scenarios: ForeshadowChildScenario[] = [
  {
    name: "setup update",
    command: "foreshadow_update_setup",
    operation: "foreshadow.setup.update",
    args: (requestId, projectId) => ({
      id: "child-update-setup",
      patch: {
        ...identity(requestId, projectId),
        baseVersion: 0,
        strength: "overt",
      },
    }),
    conflictArgs: (requestId) => ({
      id: "child-update-setup",
      patch: {
        ...identity(requestId),
        baseVersion: 0,
        strength: "moderate",
      },
    }),
  },
  {
    name: "setup create",
    command: "foreshadow_setup_create_ai",
    operation: "foreshadow.setup.create",
    args: (requestId, projectId) => ({
      ...identity(requestId, projectId),
      id: "child-created-setup",
      foreshadowId: "child-create-root",
      baseVersion: 0,
      sceneId: "child-scene",
      fromPos: 3,
      toPos: 5,
      kind: "designated_existing",
      strength: null,
      aiStrength: null,
      attribution: "human",
      aiRationale: null,
      aiReasoning: null,
      lastEvaluatedAt: null,
    }),
    conflictArgs: (requestId) => ({
      ...identity(requestId),
      id: "child-created-setup",
      foreshadowId: "child-create-root",
      baseVersion: 0,
      sceneId: "child-scene",
      fromPos: 3,
      toPos: 6,
      kind: "designated_existing",
      strength: null,
      aiStrength: null,
      attribution: "human",
      aiRationale: null,
      aiReasoning: null,
      lastEvaluatedAt: null,
    }),
  },
  {
    name: "orphan resolve",
    command: "foreshadow_resolve_orphan",
    operation: "foreshadow.orphan.resolve",
    args: (requestId, projectId) => ({
      payload: {
        ...identity(requestId, projectId),
        setupId: "child-orphan-setup",
        action: "reanchor",
        baseVersion: 0,
        sceneId: "child-scene",
        fromPos: 4,
        toPos: 7,
      },
    }),
    conflictArgs: (requestId) => ({
      payload: {
        ...identity(requestId),
        setupId: "child-orphan-setup",
        action: "reanchor",
        baseVersion: 0,
        sceneId: "child-scene",
        fromPos: 4,
        toPos: 8,
      },
    }),
  },
  {
    name: "Codex link",
    command: "foreshadow_link_codex",
    operation: "foreshadow.codex-link.create",
    args: (requestId, projectId) => ({
      payload: {
        ...identity(requestId, projectId),
        foreshadowId: "child-link-root",
        codexId: "child-codex",
        baseVersion: 0,
      },
    }),
    conflictArgs: (requestId) => ({
      payload: {
        ...identity(requestId),
        foreshadowId: "child-link-root",
        codexId: "child-codex-other",
        baseVersion: 0,
      },
    }),
  },
  {
    name: "Codex unlink",
    command: "foreshadow_unlink_codex",
    operation: "foreshadow.codex-link.delete",
    args: (requestId, projectId) => ({
      payload: {
        ...identity(requestId, projectId),
        foreshadowId: "child-unlink-root",
        codexId: "child-codex",
        baseVersion: 0,
      },
    }),
    conflictArgs: (requestId) => ({
      payload: {
        ...identity(requestId),
        foreshadowId: "child-unlink-root",
        codexId: "child-codex-other",
        baseVersion: 0,
      },
    }),
  },
  {
    name: "setup strength",
    command: "foreshadow_set_setup_strength",
    operation: "foreshadow.setup.strength",
    args: (requestId, projectId) => ({
      payload: {
        ...identity(requestId, projectId),
        setupId: "child-strength-setup",
        strength: "overt",
        baseVersion: 0,
      },
    }),
    conflictArgs: (requestId) => ({
      payload: {
        ...identity(requestId),
        setupId: "child-strength-setup",
        strength: "moderate",
        baseVersion: 0,
      },
    }),
  },
  {
    name: "scene anchor save",
    command: "foreshadow_save_anchors_for_scene",
    operation: "foreshadow.anchors.save",
    args: (requestId, projectId) => anchorArgs(requestId, projectId),
    conflictArgs: (requestId) => anchorArgs(requestId, undefined, 5),
  },
];

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function rows(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

async function seed(mock: PersistentBrowserMock): Promise<void> {
  await run(mock, "INSERT INTO projects (id) VALUES ('child-foreign-project')");
  await run(
    mock,
    `INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
     VALUES ('child-scene', 'default-project', 'scene', 'Scene', 'a0'),
            ('child-anchor-scene', 'default-project', 'scene', 'Anchor', 'a1'),
            ('child-foreign-scene', 'child-foreign-project', 'scene', 'Foreign', 'a0')`,
  );
  await run(
    mock,
    `INSERT INTO foreshadows
      (id, project_id, title, version, created_at, updated_at)
     VALUES ('child-update-root', 'default-project', 'Update', 0, 1, 1),
            ('child-create-root', 'default-project', 'Create', 0, 1, 1),
            ('child-orphan-root', 'default-project', 'Orphan', 0, 1, 1),
            ('child-link-root', 'default-project', 'Link', 0, 1, 1),
            ('child-unlink-root', 'default-project', 'Unlink', 0, 1, 1),
            ('child-strength-root', 'default-project', 'Strength', 0, 1, 1),
            ('child-anchor-a-root', 'default-project', 'Anchor A', 0, 1, 1),
            ('child-anchor-z-root', 'default-project', 'Anchor Z', 0, 1, 1)`,
  );
  await run(
    mock,
    `INSERT INTO foreshadow_setups
      (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
       attribution, is_orphan, semantic_key, created_at, updated_at)
     VALUES
      ('child-update-setup', 'child-update-root', 'child-scene', 1, 2,
       'designated_existing', 'subtle', 'human', 0,
       'child-update-root|child-scene|1|2', 1, 1),
      ('child-orphan-setup', 'child-orphan-root', 'child-scene', 1, 2,
       'designated_existing', NULL, 'human', 1,
       'child-orphan-root|child-scene|1|2', 1, 1),
      ('child-strength-setup', 'child-strength-root', 'child-scene', 1, 2,
       'designated_existing', 'subtle', 'human', 0,
       'child-strength-root|child-scene|1|2', 1, 1),
      ('child-anchor-a-setup', 'child-anchor-a-root', 'child-anchor-scene', 1, 2,
       'designated_existing', NULL, 'human', 0,
       'child-anchor-a-root|child-anchor-scene|1|2', 1, 1),
      ('child-anchor-z-setup', 'child-anchor-z-root', 'child-anchor-scene', 5, 6,
       'designated_existing', NULL, 'human', 0,
       'child-anchor-z-root|child-anchor-scene|5|6', 1, 1)`,
  );
  await run(
    mock,
    `INSERT INTO codex_entries (id, project_id, type, name)
     VALUES ('child-codex', 'default-project', 'character', 'Linked'),
            ('child-codex-other', 'default-project', 'character', 'Other'),
            ('child-codex-foreign', 'child-foreign-project', 'character', 'Foreign')`,
  );
  await run(
    mock,
    `INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
     VALUES ('child-unlink-root', 'child-codex')`,
  );
}

async function domainState(
  mock: PersistentBrowserMock,
): Promise<Record<string, unknown>> {
  return {
    roots: await rows(
      mock,
      `SELECT id, version, payoff_scene_id, payoff_from_pos, payoff_to_pos
         FROM foreshadows WHERE id LIKE 'child-%' ORDER BY id`,
    ),
    setups: await rows(
      mock,
      `SELECT id, foreshadow_id, scene_id, from_pos, to_pos, strength, is_orphan
         FROM foreshadow_setups WHERE id LIKE 'child-%' ORDER BY id`,
    ),
    links: await rows(
      mock,
      `SELECT foreshadow_id, codex_entry_id FROM foreshadow_codex_links
        WHERE foreshadow_id LIKE 'child-%'
        ORDER BY foreshadow_id, codex_entry_id`,
    ),
  };
}

describe("Browser Foreshadow child canonical Change Feed", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    await seed(mock);
  });

  afterEach(() => mock.close());

  it("accepts the Native Foreshadow identity without undoJournalId", async () => {
    const args = scenarios[0].args("child-native-identity");
    expect(args.patch).not.toHaveProperty("undoJournalId");
    await expect(
      mock.invoke("foreshadow_update_setup", args),
    ).resolves.toMatchObject({ version: 1 });

    const incomplete = scenarios[1].args("child-missing-lineage");
    delete incomplete.originalTransactionId;
    await expect(
      mock.invoke("foreshadow_setup_create_ai", incomplete),
    ).rejects.toThrow("originalTransactionId");
  });

  it.each(scenarios)(
    "$name emits once, replays exactly, and rejects semantic request reuse",
    async (scenario) => {
      const requestId = `child-retry:${scenario.name}`;
      const args = scenario.args(requestId);
      const first = await mock.invoke(scenario.command, args);
      const afterFirst = await domainState(mock);
      const replay = await mock.invoke(scenario.command, retryArgs(args));
      expect(replay).toEqual(first);
      expect(await domainState(mock)).toEqual(afterFirst);
      expect(maintenanceTransactionIds(first)).toHaveLength(1);
      expect(
        await rows(
          mock,
          `SELECT
             (SELECT COUNT(*) FROM narrative_change_transactions
               WHERE request_id = ?) AS transactions,
             (SELECT COUNT(*) FROM change_events
               WHERE project_id = 'default-project'
                 AND event_uid LIKE ?) AS canonical_events`,
          [requestId, `event:${requestId}%`],
        ),
      ).toEqual([{ transactions: 1, canonical_events: 1 }]);

      await expect(
        mock.invoke(scenario.command, scenario.conflictArgs(requestId)),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT|request id reused/i);
      expect(await domainState(mock)).toEqual(afterFirst);
    },
  );

  it.each(scenarios)(
    "$name rejects cross-project authority",
    async (scenario) => {
      const requestId = `child-cross-project:${scenario.name}`;
      const before = await domainState(mock);
      await expect(
        mock.invoke(
          scenario.command,
          scenario.args(requestId, "child-foreign-project"),
        ),
      ).rejects.toThrow(/project|same project/i);
      expect(await domainState(mock)).toEqual(before);
      expect(
        await rows(
          mock,
          "SELECT id FROM narrative_change_transactions WHERE request_id = ?",
          [requestId],
        ),
      ).toEqual([]);
    },
  );

  it.each(scenarios)(
    "$name rolls the domain and history back when Feed append fails",
    async (scenario) => {
      const requestId = `child-feed-rollback:${scenario.name}`;
      const before = await domainState(mock);
      await run(
        mock,
        `CREATE TRIGGER reject_child_foreshadow_feed
         BEFORE INSERT ON narrative_change_events
         BEGIN SELECT RAISE(ABORT, 'forced Foreshadow child Feed failure'); END`,
      );
      await expect(
        mock.invoke(scenario.command, scenario.args(requestId)),
      ).rejects.toThrow("forced Foreshadow child Feed failure");
      expect(await domainState(mock)).toEqual(before);
      expect(
        await rows(
          mock,
          `SELECT
             (SELECT COUNT(*) FROM change_events
               WHERE event_uid = ?) AS canonical_events,
             (SELECT COUNT(*) FROM narrative_change_transactions
               WHERE request_id = ?) AS transactions,
             (SELECT COUNT(*) FROM idempotency_requests
               WHERE request_id = ?) AS receipts`,
          [`event:${requestId}`, requestId, requestId],
        ),
      ).toEqual([{ canonical_events: 0, transactions: 0, receipts: 0 }]);
    },
  );

  it("orders a multi-root anchor transaction by Foreshadow id", async () => {
    const requestId = "child-anchor-order";
    const result = await mock.invoke(
      "foreshadow_save_anchors_for_scene",
      scenarios.at(-1)!.args(requestId),
    );
    const [transactionId] = maintenanceTransactionIds(result);
    expect(
      await rows(
        mock,
        `SELECT event_ordinal, object_key_json
           FROM narrative_change_events
          WHERE transaction_id = ? ORDER BY event_ordinal`,
        [transactionId],
      ),
    ).toEqual([
      {
        event_ordinal: 0,
        object_key_json: JSON.stringify({
          foreshadowId: "child-anchor-a-root",
          kind: "foreshadow",
        }),
      },
      {
        event_ordinal: 1,
        object_key_json: JSON.stringify({
          foreshadowId: "child-anchor-z-root",
          kind: "foreshadow",
        }),
      },
    ]);
  });
});
