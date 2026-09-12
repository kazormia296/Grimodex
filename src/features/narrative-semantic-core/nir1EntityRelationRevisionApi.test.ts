import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import {
  createNir1EntityRelationRevision,
  readNir1EntityRelationRevision,
} from "./nir1EntityRelationRevisionApi";

describe("NIR-1 typed Entity/Relation Revision renderer API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds creation to the Native workspace authority", async () => {
    h.invoke.mockResolvedValueOnce({
      proposalSetId: "set-1",
      proposalId: "proposal-1",
      revisionId: "revision-1",
      originKind: "nir1-typed",
      producer: "nir1-reviewed-entity-relation-v1",
      indexKey: "nir1-reviewed-entity-relation:v1",
      eligibilitySource: "nir1-entity-relation-eligibility-set",
      payloadDigest: "sha256:payload",
      status: "unreviewed",
    });
    const request = {
      runId: "run-1",
      projectId: "project-1",
      proposalKey: "review-1",
      bundle: {
        projectId: "project-1",
        revisionId: "renderer-value",
        producer: "nir1-reviewed-entity-relation-v1" as const,
        entities: [],
        relations: [],
      },
    };
    const binding = {
      authorityId: "authority-1",
      generation: 1,
      authorityInstanceId: "1",
    };

    await createNir1EntityRelationRevision(request, binding);

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_create",
      { payload: request, workspaceBinding: binding },
    );
  });

  it("reads by the exact workspace path and immutable Revision ID", async () => {
    h.invoke.mockResolvedValueOnce({
      status: "unavailable",
      result: { reason: "revision-not-human-approved" },
    });

    await readNir1EntityRelationRevision(
      "/workspace",
      "project-1",
      "revision-1",
    );

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_read",
      {
        expectedWorkspacePath: "/workspace",
        projectId: "project-1",
        revisionId: "revision-1",
      },
    );
  });
});
