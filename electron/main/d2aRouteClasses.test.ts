// NIR-1 DA-1 ST3 (K3/2 "restricted 下の route 区分"): the five publication route
// classes, the 39-command own-data-read ledger, the generic-SQL early
// classification, and the Main -> Native own-data-read classification.
//
// The own-data-read opening is a single switch (`D2A_OWN_DATA_READ_OPEN`, true
// since the opening commit, DR-DA1-35). The behavior is pinned in both states
// here: with the shipped switch on the gate routes as K3/2 specifies; with it
// forced off (`ownDataReadOpen: false` test seam) the gate keeps the a153743b
// behavior (every own-data-read reference is `plaintext-publication`).
import { describe, expect, it, vi } from "vitest";

import {
  IPC,
  NAPI_COMMANDS,
  NIR1_LOCAL_GENERATION_COMMANDS,
} from "../shared/ipcContract.js";
import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
  D2A_OWN_DATA_READ_OPEN,
  d2aCommandRouteForTest,
  d2aRouteDecision,
  d2aRouteLedgersForTest,
  type D2aRoute,
} from "./profileEgress.js";
import { activateGateForTest } from "./profileActivation.test.support.js";
import {
  NATIVE_CLOSED_TABLES,
  NATIVE_READ_OPEN_COLUMNS,
  NATIVE_READ_OPEN_TABLES,
  nativeSqlPolicyV2,
} from "./d2aSqlPolicyFixture.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: { sender: unknown },
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>
  >(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: unknown },
        cmd: unknown,
        args: unknown,
      ) => Promise<Envelope>,
    ) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));
vi.mock("./shellCommands.js", () => ({
  buildShellCommandHandlers: vi.fn(() => ({})),
  registerShellBridgeHandlers: vi.fn(),
}));
vi.mock("./windows.js", () => ({
  focusPanelWindow: vi.fn(),
  hasPanelWindow: vi.fn(),
  openPanelWindow: vi.fn(),
}));

const { registerIpcRouter } = await import("./ipc.js");

/** K3/2 "区分の構成": the 39 own-data-read commands, by group. */
const OWN_DATA_READ_BY_GROUP = {
  search: [
    "fts_search",
    "semantic_search",
    "semantic_chunk_context",
    "semantic_debug_dump",
    "codex_semantic_search",
    "events_semantic_search",
    "chat_message_search",
  ],
  codexAnalysis: [
    "codex_match_text",
    "extract_codex_candidates",
    "extract_codex_entity_seeds",
  ],
  foreshadow: [
    "foreshadow_list_with_labels",
    "foreshadow_list_open_for_context",
    "foreshadow_get_scene_info",
    "foreshadow_get_scene_context",
    "foreshadow_list_by_codex_entry",
    "foreshadow_get_chapter_stats",
    "foreshadow_get_setup",
    "foreshadow_get",
    "foreshadow_list_linked_codex",
  ],
  plot: ["plot_thread_list", "plot_thread_list_links"],
  lint: [
    "lint_ignore_list",
    "lint_ignore_list_scene",
    "lint_term_dictionary_list",
  ],
  trashAndSnapshot: ["trash_bin_list", "project_snapshot_restore_context"],
  aiRecords: [
    "ai_audit_read_snapshot",
    "ai_audit_verify",
    "list_post_effect_runs",
    "list_scene_lens_for_project",
    "list_annotations_for_scene",
    "list_annotations_for_project",
  ],
  extractionReview: [
    "narrative_extraction_get_run",
    "narrative_extraction_get_run_review_bundle",
    "narrative_extraction_list_resumable_runs",
    "narrative_extraction_is_run_resumable_for_review",
    "narrative_extraction_list_chronicle_task_resume_candidates",
    "narrative_extraction_get_commit_status",
    "narrative_maintenance_inbox_list",
  ],
} as const;
const OWN_DATA_READ_COMMANDS: readonly string[] = Object.values(
  OWN_DATA_READ_BY_GROUP,
).flat();

const DERIVED_INDEX_COMMANDS = [
  "codex_index_entry",
  "events_index_entry",
  "chat_index_message",
] as const;

const POLICY = {
  closedTables: NATIVE_CLOSED_TABLES,
  readOpenTables: NATIVE_READ_OPEN_TABLES,
  readOpenColumns: NATIVE_READ_OPEN_COLUMNS.map(
    (column) => `${column.table}.${column.column}`,
  ),
};

function route(
  command: string,
  args: Record<string, unknown> = {},
  open = true,
): D2aRoute {
  return d2aCommandRouteForTest(command, args, POLICY, open);
}

function sqlRoute(sql: unknown, open = true, bound = true): D2aRoute {
  return route(
    "db_execute",
    {
      sql,
      method: "all",
      ...(bound ? { callerIdentity: { senderId: 1 } } : {}),
    },
    open,
  );
}

function backend(restricted: boolean, activate?: () => Promise<string>) {
  const status = {
    profileId: "profile-1",
    callerEpoch: 4,
    restricted,
    handlesInvalidated: restricted,
    inFlightStopped: true,
    sqlPolicy: nativeSqlPolicyV2(),
  };
  return {
    initializeProfileEgress: async () => JSON.stringify(status),
    registerProfileEgressCaller: () => undefined,
    invalidateProfileEgressCallers: () => undefined,
    profileActivationCommit:
      activate ?? (async () => JSON.stringify({ ...status, restricted: true })),
  } as unknown as NapiBackendLike & {
    profileActivationCommit: () => Promise<string>;
  };
}

const ACTIVATED_STATUS = JSON.stringify({
  profileId: "profile-2",
  callerEpoch: 5,
  restricted: true,
  handlesInvalidated: true,
  inFlightStopped: true,
  sqlPolicy: nativeSqlPolicyV2(),
});

const DENIED = (route: string) =>
  new RegExp(`^${D2A_EGRESS_DENIED_MARKER} ${route}:`);

describe("own-data-read ledger (K3/2 区分の構成)", () => {
  it("holds exactly the 39 confirmed commands, each a real NAPI command", () => {
    const ledgers = d2aRouteLedgersForTest();
    expect(OWN_DATA_READ_COMMANDS).toHaveLength(39);
    expect(new Set(OWN_DATA_READ_COMMANDS).size).toBe(39);
    expect([...ledgers.ownDataRead].sort()).toEqual(
      [...OWN_DATA_READ_COMMANDS].sort(),
    );
    expect(Object.values(OWN_DATA_READ_BY_GROUP).map((g) => g.length)).toEqual([
      7, 3, 9, 2, 3, 2, 6, 7,
    ]);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(Object.hasOwn(NAPI_COMMANDS, command), command).toBe(true);
    }
  });

  it("routes every ledger command as own-data-read, or plaintext-publication while closed", () => {
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(route(command, {}, true), command).toBe("own-data-read");
      expect(route(command, {}, false), command).toBe("plaintext-publication");
    }
  });

  it("keeps the route ledgers pairwise disjoint (Negative (20))", () => {
    const ledgers = d2aRouteLedgersForTest();
    const names = [
      "denied",
      "internal",
      "licenseControl",
      "ownDataRead",
      "nir1Publication",
      "nir1RestrictedOnly",
      "stop",
    ] as const;
    for (const name of names) {
      expect(new Set(ledgers[name]).size, name).toBe(ledgers[name].length);
    }
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const overlap = ledgers[names[i]].filter((command) =>
          ledgers[names[j]].includes(command),
        );
        // `stop` commands are also `internal` by design (abort controls).
        const allowed =
          names[i] === "internal" && names[j] === "stop"
            ? ledgers.stop.filter((c) => ledgers.internal.includes(c))
            : [];
        expect(overlap.sort(), `${names[i]} / ${names[j]}`).toEqual(
          allowed.sort(),
        );
      }
    }
  });

  it("leaves plaintext-publication with exactly the commands K3/2 keeps closed", () => {
    // claim_task and nir1_pack_context only: the six NIR commands moved to
    // nir1-publication with their Native re-authorization (ST4).
    const plaintext = d2aRouteLedgersForTest()
      .denied.filter(
        (command) => route(command, {}, true) === "plaintext-publication",
      )
      .sort();
    expect(plaintext).toEqual(
      ["narrative_extraction_claim_task", "nir1_pack_context"].sort(),
    );
  });

  it("moves the three derived-index updates to internal", () => {
    const ledgers = d2aRouteLedgersForTest();
    for (const command of DERIVED_INDEX_COMMANDS) {
      expect(ledgers.internal, command).toContain(command);
      expect(ledgers.denied, command).not.toContain(command);
      expect(route(command), command).toBe("internal");
    }
  });

  it("holds the seven NIR commands in nir1-publication and the six local generation commands in nir1-restricted-only", () => {
    const ledgers = d2aRouteLedgersForTest();
    expect([...ledgers.nir1Publication].sort()).toEqual(
      [
        "related_scenes_begin",
        "related_scenes_continue",
        "related_scenes_graph_continue",
        "nir1_evidence_qualify",
        "nir1_entity_relation_revision_read",
        "nir1_entity_relation_revision_read_current",
        "nir1_entity_relation_revision_restore",
      ].sort(),
    );
    // K5/3's D-dispatch commands (DD-1b), exactly the route's table.  The
    // Graph wait/settle is one nir1-publication command (CP-3a), not a
    // restricted-only one.
    expect([...ledgers.nir1RestrictedOnly]).toEqual([
      ...NIR1_LOCAL_GENERATION_COMMANDS,
    ]);
    for (const command of NIR1_LOCAL_GENERATION_COMMANDS) {
      expect(route(command), command).toBe("nir1-restricted-only");
    }
    // The Main-only sender stop is in no ledger and no renderer command.
    for (const ledger of Object.values(ledgers)) {
      expect(ledger).not.toContain("main_nir1_local_generation_cancel_sender");
    }
  });
});

describe("generic SQL early classification (K3/2 区分の規則)", () => {
  const closedTable = NATIVE_CLOSED_TABLES[0];
  it.each([
    // own-data-read: SELECT / WITH over a read-open table or column
    ["SELECT content FROM chat_messages", "own-data-read"],
    ["select * from CHAT_SESSIONS where id = ?", "own-data-read"],
    ['SELECT content FROM "chat_messages"', "own-data-read"],
    ["SELECT m.content FROM main.chat_messages m", "own-data-read"],
    [
      "SELECT t.id, c.content FROM tree_nodes t JOIN chat_messages c ON c.id = t.id",
      "own-data-read",
    ],
    [
      "WITH s AS (SELECT content FROM chat_messages) SELECT content FROM s",
      "own-data-read",
    ],
    ["SELECT payload FROM change_events", "own-data-read"],
    ["SELECT * FROM change_events", "own-data-read"],
    ["SELECT payload FROM state_snapshots", "own-data-read"],
    // the write rides on a WITH prefix: first keyword decides, Native's
    // authorizer / read-only check reject the write
    [
      "WITH s AS (SELECT content FROM chat_messages) INSERT INTO app_settings(key,value) SELECT 'k', content FROM s",
      "own-data-read",
    ],
    [
      "WITH s AS (SELECT 1) DELETE FROM chat_messages WHERE id IN (SELECT 1 FROM s)",
      "own-data-read",
    ],
    // closed anywhere wins, even next to a read-open table
    [`SELECT * FROM ${closedTable}`, "plaintext-publication"],
    [
      "SELECT c.content FROM chat_messages c JOIN messages m ON m.rowid = c.rowid",
      "plaintext-publication",
    ],
    [
      `WITH s AS (SELECT * FROM ${closedTable}) SELECT * FROM chat_messages`,
      "plaintext-publication",
    ],
    ["SELECT * FROM nir1_generation_attempts", "plaintext-publication"],
    ["SELECT key FROM idempotency_requests", "plaintext-publication"],
    // DML on a ledger table, either class
    [
      "INSERT INTO chat_sessions(id,project_id) VALUES (1,2)",
      "plaintext-publication",
    ],
    ["UPDATE chat_messages SET content = 'x'", "plaintext-publication"],
    ["DELETE FROM chat_sessions", "plaintext-publication"],
    ["REPLACE INTO chat_summaries(id) VALUES (1)", "plaintext-publication"],
    // no from/join/into/update name for Main to see: unclassified is refused
    ["DROP TABLE chat_messages", "unclassified"],
    ["UPDATE change_events SET payload = ''", "plaintext-publication"],
    [
      "INSERT INTO app_settings SELECT * FROM chat_messages",
      "plaintext-publication",
    ],
    // anything else that names a read-open table is not classified as a read
    ["/* c */ SELECT content FROM chat_messages", "plaintext-publication"],
    ["EXPLAIN SELECT content FROM chat_messages", "plaintext-publication"],
    // unchanged pre-D2a classes
    ["SELECT id FROM projects", "internal"],
    ["WITH s AS (SELECT 1) SELECT * FROM app_settings", "internal"],
    ["SELECT domain, sequence FROM change_events", "internal"],
    ["INSERT INTO app_settings(key,value) VALUES (1,2)", "native-mutation"],
    ["DELETE FROM change_events WHERE sequence < 1", "native-mutation"],
    ["PRAGMA table_info(chat_messages)", "unclassified"],
    ["SELECT 1", "unclassified"],
    ["VACUUM", "unclassified"],
    [42, "unclassified"],
  ] as const)("%j -> %s", (sql, expected) => {
    expect(sqlRoute(sql, true)).toBe(expected);
    // With the opening off an own-data-read reference is simply protected.
    expect(sqlRoute(sql, false)).toBe(
      expected === "own-data-read" ? "plaintext-publication" : expected,
    );
  });

  it("does not see a table joined by comma; the write target decides then", () => {
    // K3/2 accepts this: Main's extraction only reads names after from/join/
    // into/update, so the comma-joined chat_messages is invisible to it and
    // the authority is Native (DML arm for ledger targets).
    expect(
      sqlRoute("SELECT t.id FROM tree_nodes t, chat_messages c", true),
    ).toBe("internal");
    expect(
      sqlRoute("DELETE FROM chat_sessions", true),
      "a ledger write target is still seen",
    ).toBe("plaintext-publication");
  });

  it("requires a bound caller for the pre-D2a internal and mutation classes", () => {
    expect(sqlRoute("SELECT id FROM projects", true, false)).toBe(
      "unclassified",
    );
    expect(
      sqlRoute("INSERT INTO app_settings(key,value) VALUES (1,2)", true, false),
    ).toBe("unclassified");
  });

  it("classifies a batch by its statements: plaintext, unclassified, own-data-read, mutation", () => {
    const batch = (...sqls: unknown[]) =>
      route("db_execute_batch", {
        statements: sqls.map((sql) => ({ sql, params: [], method: "run" })),
        callerIdentity: { senderId: 1 },
      });
    expect(
      batch("SELECT content FROM chat_messages", "SELECT id FROM projects"),
    ).toBe("own-data-read");
    expect(
      batch(
        "INSERT INTO app_settings(key,value) VALUES (1,2)",
        "SELECT content FROM chat_messages",
      ),
    ).toBe("own-data-read");
    expect(
      batch(
        "SELECT content FROM chat_messages",
        `SELECT * FROM ${closedTable}`,
      ),
    ).toBe("plaintext-publication");
    expect(
      batch("SELECT content FROM chat_messages", "DELETE FROM chat_sessions"),
    ).toBe("plaintext-publication");
    expect(batch("SELECT content FROM chat_messages", "PRAGMA foo")).toBe(
      "unclassified",
    );
    expect(batch("INSERT INTO app_settings(key,value) VALUES (1,2)")).toBe(
      "native-mutation",
    );
    expect(route("db_execute_batch", { statements: "nope" })).toBe(
      "unclassified",
    );
    expect(
      route("db_execute_batch", {
        statements: [null],
        callerIdentity: { senderId: 1 },
      }),
    ).toBe("unclassified");
  });
});

describe("route decision (K3/2 区分の意味)", () => {
  const ALL_ROUTES: readonly D2aRoute[] = [
    "old-external-ai",
    "old-local-ai",
    "plaintext-publication",
    "nir1-publication",
    "nir1-restricted-only",
    "own-data-read",
    "license-control",
    "external-url",
    "native-mutation",
    "internal",
    "unclassified",
  ];
  const IDENTITY_BOUND: readonly D2aRoute[] = [
    "nir1-publication",
    "nir1-restricted-only",
    "own-data-read",
  ];
  const ALWAYS_REFUSED_WHEN_RESTRICTED: readonly D2aRoute[] = [
    "old-external-ai",
    "old-local-ai",
    "plaintext-publication",
    "external-url",
    "unclassified",
  ];

  const restricted = {
    restricted: true,
    unavailable: false,
    activating: false,
    identityIssued: true,
  } as const;

  it("is exhaustive over the route classes", () => {
    expect(new Set(ALL_ROUTES).size).toBe(11);
    for (const candidate of ALL_ROUTES) {
      // every class gets a decision in every state, never a thrown error
      for (const condition of [
        { ...restricted, restricted: false },
        restricted,
        { ...restricted, activating: true },
        { ...restricted, identityIssued: false },
        { ...restricted, unavailable: true },
      ]) {
        expect(() => d2aRouteDecision(candidate, condition)).not.toThrow();
      }
    }
  });

  it("unrestricted passes everything except nir1-restricted-only", () => {
    for (const candidate of ALL_ROUTES) {
      const decision = d2aRouteDecision(candidate, {
        restricted: false,
        unavailable: false,
        activating: false,
        identityIssued: false,
      });
      expect(decision.allow, candidate).toBe(
        candidate !== "nir1-restricted-only",
      );
    }
  });

  it("restricted passes internal, native-mutation and license-control", () => {
    for (const candidate of [
      "internal",
      "native-mutation",
      "license-control",
    ] as const) {
      expect(d2aRouteDecision(candidate, restricted).allow, candidate).toBe(
        true,
      );
      // no identity is needed for these
      expect(
        d2aRouteDecision(candidate, { ...restricted, identityIssued: false })
          .allow,
        candidate,
      ).toBe(true);
    }
  });

  it("restricted refuses the egress classes and unclassified", () => {
    for (const candidate of ALWAYS_REFUSED_WHEN_RESTRICTED) {
      for (const condition of [
        restricted,
        { ...restricted, activating: true },
      ]) {
        expect(d2aRouteDecision(candidate, condition).allow, candidate).toBe(
          false,
        );
      }
    }
  });

  it("the three identity-bound classes need an issued identity outside an activation", () => {
    for (const candidate of IDENTITY_BOUND) {
      expect(d2aRouteDecision(candidate, restricted).allow, candidate).toBe(
        true,
      );
      expect(
        d2aRouteDecision(candidate, { ...restricted, identityIssued: false }),
        candidate,
      ).toMatchObject({ allow: false });
      expect(
        d2aRouteDecision(candidate, { ...restricted, activating: true }),
        candidate,
      ).toMatchObject({ allow: false });
      expect(
        d2aRouteDecision(candidate, { ...restricted, unavailable: true }),
        candidate,
      ).toMatchObject({ allow: false });
    }
  });

  it("unavailable passes only internal and native-mutation", () => {
    const unavailable = { ...restricted, unavailable: true } as const;
    for (const candidate of ALL_ROUTES) {
      expect(d2aRouteDecision(candidate, unavailable).allow, candidate).toBe(
        candidate === "internal" || candidate === "native-mutation",
      );
    }
  });

  it("nir1-restricted-only passes with the same conditions as nir1-publication when restricted (Negative (7))", () => {
    for (const condition of [
      restricted,
      { ...restricted, identityIssued: false },
      { ...restricted, activating: true },
      { ...restricted, unavailable: true },
    ]) {
      expect(d2aRouteDecision("nir1-restricted-only", condition).allow).toBe(
        d2aRouteDecision("nir1-publication", condition).allow,
      );
    }
    expect(
      d2aRouteDecision("nir1-restricted-only", {
        restricted: false,
        unavailable: false,
        activating: false,
        identityIssued: true,
      }).allow,
    ).toBe(false);
  });
});

describe("gate: own-data-read with the shipped opening (the default)", () => {
  it("follows the shipped constant", () => {
    expect(D2A_OWN_DATA_READ_OPEN).toBe(true);
  });

  it("passes every own-data-read command and SQL read in a restricted profile, and keeps the rest closed", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).not.toThrow();
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: "SELECT content FROM chat_messages",
      }),
    ).not.toThrow();
    // a classification is produced, so Native checks the statement is read-only
    expect(
      gate.classifyOwnDataRead?.("db_execute", {
        callerIdentity,
        sql: "SELECT content FROM chat_messages",
      }),
    ).toBe(true);
    // the closed class, ledger DML and the plaintext-publication commands stay
    // closed under the shipped default
    for (const sql of [
      "SELECT * FROM narrative_proposals",
      "DELETE FROM chat_messages",
      "UPDATE chat_sessions SET title = 'x'",
    ]) {
      expect(
        () =>
          gate.assertInvoke("db_execute", {
            callerIdentity,
            method: "all",
            sql,
          }),
        sql,
      ).toThrow(DENIED("plaintext-publication"));
    }
    for (const command of [
      "narrative_extraction_claim_task",
      "nir1_pack_context",
    ]) {
      expect(() => gate.assertInvoke(command, { callerIdentity })).toThrow(
        DENIED("plaintext-publication"),
      );
    }
  });

  it("still passes the derived-index updates, which publish nothing", async () => {
    const gate = await createProfileEgressGate(backend(true));
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of DERIVED_INDEX_COMMANDS) {
      expect(() =>
        gate.assertInvoke(command, { callerIdentity }),
      ).not.toThrow();
    }
  });
});

describe("gate: own-data-read with the opening forced off (test seam)", () => {
  const closed = { ownDataReadOpen: false } as const;

  it("keeps every own-data-read command and SQL read closed in a restricted profile", async () => {
    const gate = await createProfileEgressGate(backend(true), closed);
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).toThrow(DENIED("plaintext-publication"));
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity,
        method: "all",
        sql: "SELECT content FROM chat_messages",
      }),
    ).toThrow(DENIED("plaintext-publication"));
    // no classification is produced, so nothing asks Native for a read-only check
    expect(
      gate.classifyOwnDataRead?.("db_execute", {
        callerIdentity,
        sql: "SELECT content FROM chat_messages",
      }),
    ).toBeUndefined();
  });
});

describe("gate: own-data-read with the opening on", () => {
  const open = { ownDataReadOpen: true } as const;

  it("passes ledger commands and own-data SQL with a Main-issued identity", async () => {
    const gate = await createProfileEgressGate(backend(true), open);
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(
        () => gate.assertInvoke(command, { callerIdentity }),
        command,
      ).not.toThrow();
    }
    for (const sql of [
      "SELECT content FROM chat_messages",
      "WITH s AS (SELECT content FROM chat_messages) SELECT content FROM s",
      "SELECT payload FROM change_events",
    ]) {
      expect(() =>
        gate.assertInvoke("db_execute", { callerIdentity, method: "all", sql }),
      ).not.toThrow();
    }
  });

  it("keeps plaintext-publication closed: claim_task, pack_context, closed tables, ledger DML", async () => {
    const gate = await createProfileEgressGate(backend(true), open);
    const callerIdentity = gate.issueCallerIdentity(11);
    for (const command of [
      "narrative_extraction_claim_task",
      "nir1_pack_context",
    ]) {
      expect(() => gate.assertInvoke(command, { callerIdentity })).toThrow(
        DENIED("plaintext-publication"),
      );
    }
    for (const sql of [
      "SELECT * FROM narrative_proposals",
      "SELECT * FROM messages",
      "DELETE FROM chat_messages",
      "UPDATE chat_sessions SET title = 'x'",
      "INSERT INTO chat_messages(id) VALUES ('x')",
      "/* c */ SELECT content FROM chat_messages",
    ]) {
      expect(
        () =>
          gate.assertInvoke("db_execute", {
            callerIdentity,
            method: "all",
            sql,
          }),
        sql,
      ).toThrow(DENIED("plaintext-publication"));
    }
  });

  it("refuses an own-data-read without a caller identity (Negative (2))", async () => {
    const gate = await createProfileEgressGate(backend(true), open);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(() => gate.assertInvoke(command, {}), command).toThrow(
        DENIED("own-data-read"),
      );
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        method: "all",
        sql: "SELECT content FROM chat_messages",
      }),
    ).toThrow(DENIED("unclassified"));
  });

  it("refuses an identity Main did not issue, or issued to another sender", async () => {
    const gate = await createProfileEgressGate(backend(true), open);
    const issued = gate.issueCallerIdentity(11);
    gate.issueCallerIdentity(12);
    const forged = { ...issued, callerId: "forged" };
    const wrongSender = { ...issued, senderId: 12 };
    const stale = { ...issued, callerEpoch: issued.callerEpoch - 1 };
    for (const callerIdentity of [forged, wrongSender, stale]) {
      expect(() => gate.assertInvoke("fts_search", { callerIdentity })).toThrow(
        DENIED("unclassified"),
      );
      expect(() =>
        gate.assertInvoke("db_execute", {
          callerIdentity,
          method: "all",
          sql: "SELECT content FROM chat_messages",
        }),
      ).toThrow(DENIED("unclassified"));
    }
  });

  it("refuses at invoke while a first activation is in flight, then passes after it", async () => {
    let release!: (value: string) => void;
    const settled = new Promise<string>((resolve) => {
      release = resolve;
    });
    const unrestricted = backend(false, () => settled);
    const gate = await createProfileEgressGate(unrestricted, open);
    const before = gate.issueCallerIdentity(11);
    // unrestricted: an own-data-read passes without any check
    expect(() => gate.assertInvoke("fts_search", {})).not.toThrow();

    const activation = activateGateForTest(gate);
    expect(gate.restricted).toBe(true);
    for (const args of [{ callerIdentity: before }, {}]) {
      expect(() => gate.assertInvoke("fts_search", args)).toThrow(
        DENIED("own-data-read"),
      );
      expect(() => gate.assertInvoke("trash_bin_list", args)).toThrow(
        DENIED("own-data-read"),
      );
    }
    expect(() =>
      gate.assertInvoke("db_execute", {
        callerIdentity: before,
        method: "all",
        sql: "SELECT content FROM chat_messages",
      }),
    ).toThrow(DENIED("own-data-read"));

    release(ACTIVATED_STATUS);
    await activation;
    // the pre-activation identity is gone; a new one is issued after
    expect(() =>
      gate.assertInvoke("fts_search", { callerIdentity: before }),
    ).toThrow(DENIED("unclassified"));
    const after = gate.issueCallerIdentity(11);
    expect(() =>
      gate.assertInvoke("fts_search", { callerIdentity: after }),
    ).not.toThrow();
  });

  it("returns a result admitted before activation without a completion check (Q-1)", async () => {
    let release!: (value: string) => void;
    const settled = new Promise<string>((resolve) => {
      release = resolve;
    });
    const gate = await createProfileEgressGate(
      backend(false, () => settled),
      open,
    );
    const admitted = gate.issueCallerIdentity(11);
    gate.assertInvoke("fts_search", { callerIdentity: admitted });
    const activation = activateGateForTest(gate);
    // the request admitted earlier completes after restriction began
    expect(() =>
      gate.assertPlaintextPublication("fts_search", {
        callerIdentity: admitted,
      }),
    ).not.toThrow();
    expect(() =>
      gate.assertPlaintextPublication("db_execute", {
        callerIdentity: admitted,
        sql: "SELECT content FROM chat_messages",
      }),
    ).not.toThrow();
    // ... whereas plaintext-publication keeps its completion check
    expect(() =>
      gate.assertPlaintextPublication("nir1_pack_context", {
        callerIdentity: admitted,
      }),
    ).toThrow(DENIED("plaintext-publication"));
    release(ACTIVATED_STATUS);
    await activation;
  });

  it("refuses everything own-data-read when the Native gate is unavailable", async () => {
    const gate = await createProfileEgressGate(null, open);
    expect(gate.unavailable).toBe(true);
    for (const command of OWN_DATA_READ_COMMANDS) {
      expect(() => gate.assertInvoke(command, {}), command).toThrow(
        DENIED("own-data-read"),
      );
    }
    expect(gate.classifyOwnDataRead?.("db_execute", {})).toBeUndefined();
  });

  it("fails closed for an unknown Native policy version", async () => {
    const status = {
      profileId: "profile-1",
      callerEpoch: 4,
      restricted: true,
      handlesInvalidated: true,
      inFlightStopped: true,
      sqlPolicy: nativeSqlPolicyV2({ version: 3 }),
    };
    const gate = await createProfileEgressGate(
      {
        initializeProfileEgress: async () => JSON.stringify(status),
        registerProfileEgressCaller: () => undefined,
        invalidateProfileEgressCallers: () => undefined,
      } as unknown as NapiBackendLike,
      open,
    );
    expect(gate.unavailable).toBe(true);
    expect(() => gate.assertInvoke("fts_search", {})).toThrow(
      DENIED("own-data-read"),
    );
  });

  it("classifies generic SQL for Native's read-only check", async () => {
    const gate = await createProfileEgressGate(backend(true), open);
    const callerIdentity = gate.issueCallerIdentity(11);
    const classify = (args: Record<string, unknown>, command = "db_execute") =>
      gate.classifyOwnDataRead!(command, { callerIdentity, ...args });
    expect(classify({ sql: "SELECT content FROM chat_messages" })).toBe(true);
    expect(
      classify({
        sql: "WITH s AS (SELECT content FROM chat_messages) INSERT INTO app_settings(key,value) SELECT 'k', content FROM s",
      }),
    ).toBe(true);
    expect(classify({ sql: "SELECT value FROM app_settings" })).toBe(false);
    expect(classify({ sql: "UPDATE app_settings SET value = 1" })).toBe(false);
    expect(
      classify(
        {
          statements: [
            { sql: "SELECT content FROM chat_messages" },
            { sql: "INSERT INTO app_settings(key,value) VALUES (1,2)" },
            null,
          ],
        },
        "db_execute_batch",
      ),
    ).toEqual([true, false, false]);
    expect(classify({ statements: "x" }, "db_execute_batch")).toBeUndefined();
    expect(classify({}, "fts_search")).toBeUndefined();
  });

  it("produces no classification for an unrestricted profile", async () => {
    const gate = await createProfileEgressGate(backend(false), open);
    expect(
      gate.classifyOwnDataRead?.("db_execute", {
        sql: "SELECT content FROM chat_messages",
      }),
    ).toBeUndefined();
  });
});

describe("router: the own-data-read classification only comes from Main", () => {
  async function routerWith(ownDataReadOpen: boolean) {
    mocks.handlers.clear();
    const dbExecute = vi.fn(async (..._args: unknown[]) =>
      JSON.stringify({ rows: [] }),
    );
    const dbExecuteBatch = vi.fn(async (..._args: unknown[]) =>
      JSON.stringify({ rows: [] }),
    );
    const base = backend(true);
    const nativeBackend = {
      ...base,
      dbExecute,
      dbExecuteBatch,
    } as unknown as NapiBackendLike;
    const gate = await createProfileEgressGate(nativeBackend, {
      ownDataReadOpen,
    });
    registerIpcRouter(
      nativeBackend,
      {},
      undefined,
      undefined,
      { active: false },
      gate,
    );
    const invoke = mocks.handlers.get(IPC.invoke)!;
    return { invoke, dbExecute, dbExecuteBatch, gate };
  }
  const event = { sender: { id: 11 } };

  it("attaches the classification for db_execute and db_execute_batch", async () => {
    const { invoke, dbExecute, dbExecuteBatch } = await routerWith(true);
    const read = await invoke(event, "db_execute", {
      sql: "SELECT content FROM chat_messages",
      params: [],
      method: "all",
    });
    expect(read.ok).toBe(true);
    const write = await invoke(event, "db_execute", {
      sql: "INSERT INTO app_settings(key,value) VALUES (?, ?)",
      params: ["k", "v"],
      method: "run",
    });
    expect(write.ok).toBe(true);
    expect(dbExecute.mock.calls[0]).toHaveLength(5);
    expect(dbExecute.mock.calls[0]?.[4]).toBe(true);
    expect(dbExecute.mock.calls[1]?.[4]).toBe(false);

    const batch = await invoke(event, "db_execute_batch", {
      statements: [
        { sql: "SELECT content FROM chat_messages", params: [], method: "all" },
        {
          sql: "INSERT INTO app_settings(key,value) VALUES (?, ?)",
          params: ["k", "v"],
          method: "run",
        },
      ],
    });
    expect(batch.ok).toBe(true);
    expect(dbExecuteBatch.mock.calls[0]?.[2]).toEqual([true, false]);
  });

  it("ignores a classification a renderer supplies, under any key", async () => {
    const { invoke, dbExecute, dbExecuteBatch } = await routerWith(true);
    const forged = Symbol.for("grimodex.d2a.dbOwnDataRead");
    await invoke(event, "db_execute", {
      sql: "INSERT INTO app_settings(key,value) VALUES (?, ?)",
      params: ["k", "v"],
      method: "run",
      ownDataRead: true,
      d2aOwnDataRead: false,
      [forged]: true,
    });
    // Main classified it itself: a plain write is not an own-data-read
    expect(dbExecute.mock.calls[0]?.[4]).toBe(false);
    await invoke(event, "db_execute_batch", {
      statements: [
        {
          sql: "INSERT INTO app_settings(key,value) VALUES (?, ?)",
          params: [],
          method: "run",
        },
      ],
      ownDataRead: [true],
    });
    expect(dbExecuteBatch.mock.calls[0]?.[2]).toEqual([false]);
  });

  it("sends no classification while the opening is off", async () => {
    const { invoke, dbExecute } = await routerWith(false);
    const read = await invoke(event, "db_execute", {
      sql: "SELECT content FROM chat_messages",
      params: [],
      method: "all",
    });
    expect(read.ok).toBe(false);
    expect(dbExecute).not.toHaveBeenCalled();
    const write = await invoke(event, "db_execute", {
      sql: "INSERT INTO app_settings(key,value) VALUES (?, ?)",
      params: ["k", "v"],
      method: "run",
    });
    expect(write.ok).toBe(true);
    expect(dbExecute.mock.calls[0]).toHaveLength(4);
  });
});
