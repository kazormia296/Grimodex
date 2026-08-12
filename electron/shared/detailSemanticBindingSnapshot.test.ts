import { describe, expect, it, vi } from "vitest";

import {
  dispatchInvoke,
  type NapiBackendLike,
  type ShellCommandHandlers,
} from "./ipcContract.js";

describe("detail semantic binding snapshot IPC contract", () => {
  it("allows the native restore plan to insert a semantic binding row", async () => {
    const projectSnapshotApplyRestore = vi.fn().mockResolvedValue(undefined);
    const backend = {
      projectSnapshotApplyRestore,
    } as unknown as NapiBackendLike;

    const payload = {
      projectId: "project-1",
      snapshotId: "snapshot-1",
      scopes: ["codex"],
      inserts: [
        {
          table: "codex_detail_semantic_bindings",
          mode: "insert",
          row: {
            id: "binding-1",
            project_id: "project-1",
            definition_id: "definition-1",
            facet_key: "character.role",
            projection_kind: "scalar-text",
            temporal_policy: "base-only",
            source: "preset",
            confirmed: 1,
            version: 0,
            created_at: "2026-08-10T00:00:00.000Z",
            updated_at: "2026-08-10T00:00:00.000Z",
          },
        },
      ],
    };

    const result = await dispatchInvoke(
      "project_snapshot_apply_restore",
      { payload },
      {
        backend,
        shell: {} as ShellCommandHandlers,
      },
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(projectSnapshotApplyRestore).toHaveBeenCalledExactlyOnceWith(
      payload,
    );
  });
});
