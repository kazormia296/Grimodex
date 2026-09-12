import { describe, expect, it, vi } from "vitest";

import { dispatchInvoke } from "./ipcContract.js";
import type { NapiBackendLike } from "./ipcContract.js";

const workspaceBinding = {
  authorityId: "authority-1",
  generation: 1,
  authorityInstanceId: "1",
};

const bundle = {
  projectId: "project-1",
  revisionId: "renderer-value-is-replaced-by-native",
  producer: "nir1-reviewed-entity-relation-v1",
  entities: [],
  relations: [],
};

describe("NIR-1 typed Entity/Relation revision IPC contract", () => {
  it("forwards only the typed request and Native workspace binding", async () => {
    const create = vi.fn().mockResolvedValue(
      JSON.stringify({
        proposalSetId: "set-1",
        proposalId: "proposal-1",
        revisionId: "revision-1",
        status: "unreviewed",
      }),
    );
    const backend = {
      nir1EntityRelationRevisionCreate: create,
    } as unknown as NapiBackendLike;

    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_create",
      {
        payload: {
          runId: "run-1",
          projectId: "project-1",
          proposalKey: "review-1",
          bundle,
        },
        workspaceBinding,
      },
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        proposalSetId: "set-1",
        proposalId: "proposal-1",
        revisionId: "revision-1",
        status: "unreviewed",
      },
    });
    expect(create).toHaveBeenCalledExactlyOnceWith(
      {
        runId: "run-1",
        projectId: "project-1",
        proposalKey: "review-1",
        bundle,
      },
      workspaceBinding,
    );
  });

  it("reads through an explicit workspace path and revision identity", async () => {
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({ status: "unavailable", result: { reason: "revision-not-current" } }),
    );
    const backend = {
      nir1EntityRelationRevisionRead: read,
    } as unknown as NapiBackendLike;

    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_read",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        revisionId: "revision-1",
      },
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        status: "unavailable",
        result: { reason: "revision-not-current" },
      },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      revisionId: "revision-1",
    });
  });

  it("rejects a missing typed bundle before creating a revision", async () => {
    const create = vi.fn();
    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_create",
      {
        payload: {
          runId: "run-1",
          projectId: "project-1",
          proposalKey: "review-1",
        },
        workspaceBinding,
      },
      {
        backend: { nir1EntityRelationRevisionCreate: create } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );

    expect(result.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unbound top-level renderer field", async () => {
    const create = vi.fn();
    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_create",
      {
        payload: { runId: "run-1", projectId: "project-1", proposalKey: "review-1", bundle },
        workspaceBinding,
        owner: "renderer-is-not-authority",
      },
      {
        backend: { nir1EntityRelationRevisionCreate: create } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );

    expect(result.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
