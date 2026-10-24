/**
 * Renderer wrapper of the DA-2b typed writers (NIR-1 DA-2b; DR-DA2-50..53 in
 * `docs/plans/nir1-lane-decisions/da2-decisions.md`, DR-DA2B-R1..R3 in
 * `da2b-renderer-decisions.md`).
 *
 * Every command is an ordinary `internal` command: the request is
 * `{ payload }`, Main re-validates it (`NAPI_COMMANDS` in
 * `electron/shared/ipcContract.ts`; exact keys, id lengths, array sizes, enums
 * and integer ranges) and Native answers with counts or typed results only,
 * never plaintext. The payload and result shapes below are those validators'
 * and writers' shapes; the contract module exports no renderer types, so they
 * are restated here and fixed by `typedWriters.test.ts`.
 *
 * Both modes use the same writers (D-11 (a)): the renderer has no mode branch.
 * A typed refusal is an `Error` whose message carries the prefix of
 * `TypedWriteRefusalPrefix`; the CW admission failure is the existing
 * `D2A_EGRESS_DENIED`.
 */
export interface TypedWriterCommands {
  chat_messages_delete: {
    payload: ChatScope & { sessionId: string; messageIds: string[] };
    result: { deleted: number };
  };
  chat_session_delete: {
    payload: ChatScope & { sessionId: string };
    result: { deleted: number };
  };
  chat_project_history_clear: {
    payload: ChatScope;
    result: { deletedSessions: number };
  };
  chat_session_rename: {
    payload: ChatScope & { sessionId: string; title: string };
    result: { updated: number };
  };
  chat_message_metadata_record: {
    payload: ChatScope & { messageId: string; patch: ChatMessageRecordPatch };
    result: { updated: number };
  };
  revision_create: {
    payload: {
      projectId: string;
      entityType: "scene" | "note" | "codex_entry" | "snippet";
      entityId: string;
      content: string;
      snapshotType: "auto" | "manual";
    };
    result: {
      created: boolean;
      id: string;
      versionNumber: number;
      createdAt: string;
    };
  };
  revision_prune: {
    payload: {
      projectId: string;
      entityType: "scene" | "note" | "codex_entry" | "snippet";
      entityId: string;
      keepCount: number;
    };
    result: { deleted: number };
  };
  project_snapshot_delete: {
    payload: { projectId: string; snapshotId: string };
    result: { deleted: number };
  };
  impact_review_baseline_update_visibility: {
    payload: {
      projectId: string;
      entryId: string;
      expectedContentHash: string;
      snapshotJson: string;
      contentHash: string;
    };
    result: { updated: boolean };
  };
}

/** `expectedWorkspacePath` is the Scope entry's value (`workspaceIdentity.path`). */
export interface ChatScope {
  expectedWorkspacePath: string;
  projectId: string;
}

/** The only metadata keys the record writer accepts (CW condition 2). */
export interface ChatMessageRecordPatch {
  extractedCodex?: string[];
  extractedSnippets?: string[];
  insertedToEditor?: boolean;
}

export type TypedWriteRefusalPrefix =
  | "CHAT_WRITE_REFUSED:"
  | "REVISION_WRITE_REFUSED:"
  | "PROJECT_SNAPSHOT_WRITE_REFUSED:"
  | "IMPACT_BASELINE_WRITE_REFUSED:";

/**
 * The typed signature of `invoke` for these commands. This module is
 * type-only (no runtime code), so it adds no chunk to the startup JS graph
 * (DR-DA2-30, DR-DA2B-R1); a caller binds its own `invoke`:
 *
 *     const invokeTypedWriter: InvokeTypedWriter = (command, args) =>
 *       invoke(command, args);
 *     await invokeTypedWriter("chat_session_delete", { payload });
 */
export type InvokeTypedWriter = <C extends keyof TypedWriterCommands>(
  command: C,
  args: { payload: TypedWriterCommands[C]["payload"] },
) => Promise<TypedWriterCommands[C]["result"]>;
