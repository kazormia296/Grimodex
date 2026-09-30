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

  it("forwards only live identities for the Native atomic prepare path", async () => {
    const prepare = vi.fn().mockResolvedValue(
      JSON.stringify({
        runId: "run-typed-1",
        status: "draft",
        receipt: {
          proposalSetId: "set-typed-1",
          proposalId: "proposal-typed-1",
          revisionId: "revision-typed-1",
          status: "unreviewed",
        },
      }),
    );
    const backend = {
      nir1EntityRelationRevisionPrepare: prepare,
    } as unknown as NapiBackendLike;
    const payload = {
      projectId: "project-1",
      sceneId: "scene-1",
      entityIds: ["entity-1"],
      relationIds: ["relation-1"],
      proposalKey: "review-1",
    };

    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_prepare",
      { payload, workspaceBinding },
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        runId: "run-typed-1",
        status: "draft",
        receipt: {
          proposalSetId: "set-typed-1",
          proposalId: "proposal-typed-1",
          revisionId: "revision-typed-1",
          status: "unreviewed",
        },
      },
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(payload, workspaceBinding);
  });

  it("forwards the dedicated typed cold reader through the Native adapter", async () => {
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        status: "unavailable",
        result: { reason: "revision-not-found" },
      }),
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
        result: { reason: "revision-not-found" },
      },
    });
    expect(read).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      revisionId: "revision-1",
    });
  });

  it("forwards the dedicated current-by-run reader through the Native adapter", async () => {
    const readCurrent = vi.fn().mockResolvedValue(
      JSON.stringify({
        status: "draft",
        result: { revisionId: "revision-1", bundle },
      }),
    );
    const backend = {
      nir1EntityRelationRevisionReadCurrent: readCurrent,
    } as unknown as NapiBackendLike;

    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_read_current",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        runId: "run-typed-1",
      },
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: { status: "draft", result: { revisionId: "revision-1", bundle } },
    });
    expect(readCurrent).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      runId: "run-typed-1",
    });
  });

  it("forwards target-aware restore through the Native typed-family adapter", async () => {
    const restore = vi.fn().mockResolvedValue(
      JSON.stringify({
        runId: "run-typed-1",
        response: {
          status: "available",
          result: { revisionId: "revision-1" },
        },
      }),
    );
    const backend = {
      nir1EntityRelationRevisionRestore: restore,
    } as unknown as NapiBackendLike;
    const payload = {
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      entityId: "entity-1",
      relationId: "relation-1",
    };

    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_restore",
      payload,
      { backend, shell: {} as never },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        runId: "run-typed-1",
        response: {
          status: "available",
          result: { revisionId: "revision-1" },
        },
      },
    });
    expect(restore).toHaveBeenCalledExactlyOnceWith(payload);
  });

  it("rejects malformed target-aware restore arguments before Native", async () => {
    const restore = vi.fn();
    const backend = {
      nir1EntityRelationRevisionRestore: restore,
    } as unknown as NapiBackendLike;
    const valid = {
      expectedWorkspacePath: "/workspace",
      projectId: "project-1",
      entityId: "entity-1",
      relationId: "relation-1",
    };

    for (const args of [
      {},
      { ...valid, entityId: " entity-1" },
      { ...valid, relationId: "" },
      { ...valid, relationId: undefined },
      { ...valid, unexpected: true },
    ]) {
      const result = await dispatchInvoke(
        "nir1_entity_relation_revision_restore",
        args,
        { backend, shell: {} as never },
      );
      expect(result.ok).toBe(false);
    }
    expect(restore).not.toHaveBeenCalled();
  });

  it("rejects malformed typed cold-reader arguments before Native", async () => {
    const read = vi.fn();
    const backend = {
      nir1EntityRelationRevisionRead: read,
    } as unknown as NapiBackendLike;

    for (const args of [
      {},
      { expectedWorkspacePath: "/workspace", projectId: "project-1" },
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        revisionId: "revision-1",
        bundle,
      },
      {
        expectedWorkspacePath: " /workspace",
        projectId: "project-1",
        revisionId: "revision-1",
      },
    ]) {
      const result = await dispatchInvoke(
        "nir1_entity_relation_revision_read",
        args,
        { backend, shell: {} as never },
      );
      expect(result.ok).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects duplicate or empty prepare identities before Native", async () => {
    const prepare = vi.fn();
    const backend = {
      nir1EntityRelationRevisionPrepare: prepare,
    } as unknown as NapiBackendLike;
    for (const payload of [
      {
        projectId: "project-1",
        sceneId: "scene-1",
        entityIds: [],
        relationIds: [],
      },
      {
        projectId: "project-1",
        sceneId: "scene-1",
        entityIds: ["entity-1"],
        relationIds: ["relation-1", "relation-1"],
      },
      {
        projectId: "project-1",
        sceneId: "scene-1",
        entityIds: [" entity-1"],
        relationIds: [],
      },
    ]) {
      const result = await dispatchInvoke(
        "nir1_entity_relation_revision_prepare",
        { payload, workspaceBinding },
        { backend, shell: {} as never },
      );
      expect(result.ok).toBe(false);
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects extra current-by-run fields before Native", async () => {
    const readCurrent = vi.fn();
    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_read_current",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        runId: "run-1",
        revisionId: "forged-payload-readback",
      },
      {
        backend: {
          nir1EntityRelationRevisionReadCurrent: readCurrent,
        } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );
    expect(result.ok).toBe(false);
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it("returns a backend-unavailable envelope for the typed cold reader", async () => {
    const result = await dispatchInvoke(
      "nir1_entity_relation_revision_read",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        revisionId: "revision-1",
      },
      { backend: null, shell: {} as never },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: nir1_entity_relation_revision_read",
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
        backend: {
          nir1EntityRelationRevisionCreate: create,
        } as unknown as NapiBackendLike,
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
        payload: {
          runId: "run-1",
          projectId: "project-1",
          proposalKey: "review-1",
          bundle,
        },
        workspaceBinding,
        owner: "renderer-is-not-authority",
      },
      {
        backend: {
          nir1EntityRelationRevisionCreate: create,
        } as unknown as NapiBackendLike,
        shell: {} as never,
      },
    );

    expect(result.ok).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
