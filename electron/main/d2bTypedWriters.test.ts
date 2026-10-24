// NIR-1 DA-2b ST4-A (DR-DA2-50..53): the nine typed Native writers are
// ordinary `internal` commands. Main routes them as `internal` in every
// profile state, re-validates their arguments before Native, forwards the
// issued caller identity to the CW entries only, and keeps the generic-SQL
// DML on the same tables closed while restricted.
import { describe, expect, it, vi } from "vitest";

import { NAPI_COMMANDS } from "../shared/ipcContract.js";
import type { DispatchDeps, NapiBackendLike } from "../shared/ipcContract.js";
import {
  d2aCommandRouteForTest,
  d2aRouteDecision,
  d2aRouteLedgersForTest,
  type D2aRoute,
} from "./profileEgress.js";
import {
  NATIVE_CLOSED_TABLES,
  NATIVE_READ_OPEN_COLUMNS,
  NATIVE_READ_OPEN_TABLES,
} from "./d2aSqlPolicyFixture.js";

const CW_COMMANDS = {
  chat_messages_delete: "chatMessagesDelete",
  chat_session_delete: "chatSessionDelete",
  chat_project_history_clear: "chatProjectHistoryClear",
  chat_session_rename: "chatSessionRename",
  chat_message_metadata_record: "chatMessageMetadataRecord",
} as const;
const M_T_COMMANDS = {
  revision_create: "revisionCreate",
  revision_prune: "revisionPrune",
  project_snapshot_delete: "projectSnapshotDelete",
  impact_review_baseline_update_visibility:
    "impactReviewBaselineUpdateVisibility",
} as const;
const ALL_COMMANDS = { ...CW_COMMANDS, ...M_T_COMMANDS };

const WORKSPACE = "/tmp/workspace";
const VALID_PAYLOADS: Record<keyof typeof ALL_COMMANDS, object> = {
  chat_messages_delete: {
    expectedWorkspacePath: WORKSPACE,
    projectId: "p1",
    sessionId: "s1",
    messageIds: ["m1", "m2"],
  },
  chat_session_delete: {
    expectedWorkspacePath: WORKSPACE,
    projectId: "p1",
    sessionId: "s1",
  },
  chat_project_history_clear: {
    expectedWorkspacePath: WORKSPACE,
    projectId: "p1",
  },
  chat_session_rename: {
    expectedWorkspacePath: WORKSPACE,
    projectId: "p1",
    sessionId: "s1",
    title: "題",
  },
  chat_message_metadata_record: {
    expectedWorkspacePath: WORKSPACE,
    projectId: "p1",
    messageId: "m1",
    patch: { extractedCodex: ["c1"], insertedToEditor: true },
  },
  revision_create: {
    projectId: "p1",
    entityType: "scene",
    entityId: "scene-1",
    content: "{}",
    snapshotType: "auto",
  },
  revision_prune: {
    projectId: "p1",
    entityType: "codex_entry",
    entityId: "codex-1",
    keepCount: 50,
  },
  project_snapshot_delete: { projectId: "p1", snapshotId: "snap-1" },
  impact_review_baseline_update_visibility: {
    projectId: "p1",
    entryId: "codex-1",
    expectedContentHash: "811c9dc5",
    snapshotJson: "{}",
    contentHash: "5465b825",
  },
};

const POLICY = {
  closedTables: NATIVE_CLOSED_TABLES,
  readOpenTables: NATIVE_READ_OPEN_TABLES,
  readOpenColumns: NATIVE_READ_OPEN_COLUMNS.map(
    (column) => `${column.table}.${column.column}`,
  ),
};

function route(command: string, args: Record<string, unknown> = {}): D2aRoute {
  return d2aCommandRouteForTest(command, args, POLICY, true);
}

/** A backend whose methods record their arguments and answer `{"ok":1}`. */
function recordingBackend() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const backend: Record<string, unknown> = {};
  for (const method of Object.values(ALL_COMMANDS)) {
    backend[method] = vi.fn(async (...args: unknown[]) => {
      calls.push({ method, args });
      return '{"ok":1}';
    });
  }
  return { backend: backend as unknown as NapiBackendLike, calls };
}

function withIdentity(args: Record<string, unknown>): Record<string, unknown> {
  // Main attaches the issued identity as a non-enumerable sidecar.
  return Object.defineProperty({ ...args }, "callerIdentity", {
    value: { senderId: 7, callerId: "caller" },
    enumerable: false,
  });
}

const deps = {} as DispatchDeps;

describe("DA-2b typed writers: route class", () => {
  it("routes all nine commands as internal and lists them only there", () => {
    const ledgers = d2aRouteLedgersForTest();
    for (const command of Object.keys(ALL_COMMANDS)) {
      expect(route(command), command).toBe("internal");
      expect(ledgers.internal, command).toContain(command);
      for (const other of [
        ledgers.denied,
        ledgers.ownDataRead,
        ledgers.nir1Publication,
        ledgers.nir1RestrictedOnly,
        ledgers.licenseControl,
      ]) {
        expect(other, command).not.toContain(command);
      }
      expect(Object.hasOwn(NAPI_COMMANDS, command), command).toBe(true);
    }
  });

  it("Main passes internal while restricted, activating and unavailable", () => {
    const restricted = {
      restricted: true,
      unavailable: false,
      activating: false,
      identityIssued: true,
    };
    for (const condition of [
      restricted,
      { ...restricted, activating: true },
      { ...restricted, identityIssued: false },
      { ...restricted, unavailable: true },
      { ...restricted, restricted: false },
    ]) {
      expect(d2aRouteDecision("internal", condition)).toEqual({ allow: true });
    }
  });

  it("keeps the generic-SQL DML these writers replace closed while restricted", () => {
    for (const sql of [
      "DELETE FROM chat_messages WHERE id = ?",
      "DELETE FROM chat_sessions WHERE id = ?",
      "DELETE FROM chat_sessions WHERE project_id = ?",
      "UPDATE chat_sessions SET title = ?, title_manual = 1 WHERE id = ?",
      "UPDATE chat_messages SET metadata = ? WHERE id = ?",
      "INSERT INTO content_versions (id, content) VALUES (?, ?)",
      "DELETE FROM content_versions WHERE id = ?",
      "UPDATE impact_review_baselines SET snapshot_json = ? WHERE entry_id = ?",
    ]) {
      expect(
        route("db_execute", {
          sql,
          method: "run",
          callerIdentity: { senderId: 1 },
        }),
        sql,
      ).toBe("plaintext-publication");
    }
  });
});

describe("DA-2b typed writers: Main re-validation", () => {
  it("forwards a validated copy, with the identity sidecar for CW only", async () => {
    for (const [command, method] of Object.entries(ALL_COMMANDS)) {
      const { backend, calls } = recordingBackend();
      const payload = VALID_PAYLOADS[command as keyof typeof ALL_COMMANDS];
      const value = await NAPI_COMMANDS[command].run(
        backend,
        withIdentity({ payload }),
        deps,
      );
      expect(value, command).toEqual({ ok: 1 });
      expect(calls, command).toHaveLength(1);
      expect(calls[0].method).toBe(method);
      expect(calls[0].args[0], command).toEqual(payload);
      if (command in CW_COMMANDS) {
        expect(JSON.parse(calls[0].args[1] as string), command).toEqual({
          senderId: 7,
          callerId: "caller",
        });
      } else {
        expect(calls[0].args, command).toHaveLength(1);
      }
    }
  });

  it("keeps the original arity without an identity", async () => {
    const { backend, calls } = recordingBackend();
    await NAPI_COMMANDS.chat_session_delete.run(
      backend,
      { payload: VALID_PAYLOADS.chat_session_delete },
      deps,
    );
    expect(calls[0].args).toHaveLength(1);
  });

  const invalid: Array<[keyof typeof ALL_COMMANDS, Record<string, unknown>]> = [
    ["chat_messages_delete", { messageIds: [] }],
    [
      "chat_messages_delete",
      { messageIds: Array.from({ length: 257 }, (_, i) => `m${i}`) },
    ],
    ["chat_messages_delete", { messageIds: [""] }],
    ["chat_messages_delete", { sessionId: "x".repeat(257) }],
    ["chat_messages_delete", { extra: true }],
    ["chat_session_delete", { expectedWorkspacePath: "" }],
    ["chat_session_rename", { title: "x".repeat(4097) }],
    ["chat_session_rename", { title: 1 }],
    ["chat_message_metadata_record", { patch: {} }],
    ["chat_message_metadata_record", { patch: { extractedCodex: "c1" } }],
    ["chat_message_metadata_record", { patch: { insertedToEditor: "yes" } }],
    ["revision_create", { entityType: "chapter" }],
    ["revision_create", { snapshotType: "draft" }],
    ["revision_create", { content: 1 }],
    ["revision_prune", { keepCount: -1 }],
    ["revision_prune", { keepCount: 100_001 }],
    ["revision_prune", { keepCount: 1.5 }],
    ["project_snapshot_delete", { snapshotId: "" }],
    [
      "impact_review_baseline_update_visibility",
      { contentHash: "x".repeat(65) },
    ],
  ];
  it.each(invalid)("%s rejects %j before Native", async (command, override) => {
    const { backend, calls } = recordingBackend();
    const payload = {
      ...VALID_PAYLOADS[command],
      ...override,
    };
    await expect(
      NAPI_COMMANDS[command].run(backend, { payload }, deps),
    ).rejects.toThrow(/invalid args/);
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown top-level argument and a missing payload", async () => {
    const { backend, calls } = recordingBackend();
    await expect(
      NAPI_COMMANDS.revision_create.run(
        backend,
        { payload: VALID_PAYLOADS.revision_create, extra: 1 },
        deps,
      ),
    ).rejects.toThrow(/unknown field/);
    await expect(
      NAPI_COMMANDS.chat_session_delete.run(backend, {}, deps),
    ).rejects.toThrow(/payload/);
    expect(calls).toHaveLength(0);
  });

  it("answers a non-record metadata key with Native's typed reason", async () => {
    const { backend, calls } = recordingBackend();
    await expect(
      NAPI_COMMANDS.chat_message_metadata_record.run(
        backend,
        {
          payload: {
            ...VALID_PAYLOADS.chat_message_metadata_record,
            patch: { thinking_blocks: [] },
          },
        },
        deps,
      ),
    ).rejects.toThrow(/^CHAT_WRITE_REFUSED:metadata-key-not-allowed/);
    expect(calls).toHaveLength(0);
  });
});
