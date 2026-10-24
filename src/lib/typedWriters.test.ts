import { describe, expect, it } from "vitest";
import {
  NAPI_COMMANDS,
  type NapiBackendLike,
} from "../../electron/shared/ipcContract";
import type { TypedWriterCommands } from "./typedWriters";

// The renderer's payload and result types of the DA-2b typed writers
// (`typedWriters.ts`) are restated from Main's validators and Native's
// writers. Run each renderer-shaped request through Main's real validator
// (`NAPI_COMMANDS`, exact keys and bounds) with a backend that records what
// Native would receive, so a drift of a key or a shape fails here.

type Samples = {
  [C in keyof TypedWriterCommands]: {
    payload: TypedWriterCommands[C]["payload"];
    method: keyof NapiBackendLike;
    result: TypedWriterCommands[C]["result"];
  };
};

const scope = { expectedWorkspacePath: "/ws", projectId: "p1" };

const SAMPLES: Samples = {
  chat_messages_delete: {
    payload: { ...scope, sessionId: "s1", messageIds: ["m1", "m2"] },
    method: "chatMessagesDelete",
    result: { deleted: 2 },
  },
  chat_session_delete: {
    payload: { ...scope, sessionId: "s1" },
    method: "chatSessionDelete",
    result: { deleted: 1 },
  },
  chat_project_history_clear: {
    payload: scope,
    method: "chatProjectHistoryClear",
    result: { deletedSessions: 3 },
  },
  chat_session_rename: {
    payload: { ...scope, sessionId: "s1", title: "T" },
    method: "chatSessionRename",
    result: { updated: 1 },
  },
  chat_message_metadata_record: {
    payload: {
      ...scope,
      messageId: "m1",
      patch: { extractedCodex: ["c1"], insertedToEditor: true },
    },
    method: "chatMessageMetadataRecord",
    result: { updated: 1 },
  },
  revision_create: {
    payload: {
      projectId: "p1",
      entityType: "scene",
      entityId: "e1",
      content: "{}",
      snapshotType: "auto",
    },
    method: "revisionCreate",
    result: {
      created: true,
      id: "v1",
      versionNumber: 1,
      createdAt: "2026-10-24T00:00:00.000Z",
    },
  },
  revision_prune: {
    payload: {
      projectId: "p1",
      entityType: "codex_entry",
      entityId: "e1",
      keepCount: 50,
    },
    method: "revisionPrune",
    result: { deleted: 0 },
  },
  project_snapshot_delete: {
    payload: { projectId: "p1", snapshotId: "x1" },
    method: "projectSnapshotDelete",
    result: { deleted: 1 },
  },
  impact_review_baseline_update_visibility: {
    payload: {
      projectId: "p1",
      entryId: "c1",
      expectedContentHash: "0000abcd",
      snapshotJson: "{}",
      contentHash: "ffff0000",
    },
    method: "impactReviewBaselineUpdateVisibility",
    result: { updated: true },
  },
};

describe("DA-2b typed writer wrapper types", () => {
  it.each(Object.keys(SAMPLES) as Array<keyof TypedWriterCommands>)(
    "%s: Main accepts the renderer's payload unchanged and answers the typed result",
    async (command) => {
      const sample = SAMPLES[command];
      const received: unknown[] = [];
      const backend = {
        [sample.method]: async (payload: unknown) => {
          received.push(payload);
          return JSON.stringify(sample.result);
        },
      } as unknown as NapiBackendLike;
      const spec = NAPI_COMMANDS[command];
      expect(spec).toBeDefined();
      await expect(
        // These commands use no dispatch dependency (no secrets).
        spec.run(backend, { payload: sample.payload }, {} as never),
      ).resolves.toEqual(sample.result);
      expect(received).toEqual([sample.payload]);
    },
  );

  it("covers exactly the nine DA-2b commands", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(
      [
        "chat_message_metadata_record",
        "chat_messages_delete",
        "chat_project_history_clear",
        "chat_session_delete",
        "chat_session_rename",
        "impact_review_baseline_update_visibility",
        "project_snapshot_delete",
        "revision_create",
        "revision_prune",
      ].sort(),
    );
  });
});
