import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));

import {
  createNir1EntityRelationRevision,
  decideNir1EntityRelationRevision,
  prepareNir1EntityRelationRevision,
  readCurrentNir1EntityRelationRevision,
  readNir1EntityRelationRevision,
  restoreNir1EntityRelationRevision,
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

  it("uses the dedicated Native cold reader with explicit workspace identity", async () => {
    h.invoke.mockResolvedValueOnce({
      status: "unavailable",
      result: { reason: "revision-not-human-approved" },
    });

    await readNir1EntityRelationRevision({
      expectedWorkspacePath: "/workspace/project-1",
      projectId: "project-1",
      revisionId: "revision-1",
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_read",
      {
        expectedWorkspacePath: "/workspace/project-1",
        projectId: "project-1",
        revisionId: "revision-1",
      },
    );
  });

  it("prepares a dedicated typed review Run from live identities", async () => {
    h.invoke.mockResolvedValueOnce({
      runId: "run-1",
      status: "draft",
      receipt: {
        proposalSetId: "set-1",
        proposalId: "proposal-1",
        revisionId: "revision-1",
        status: "unreviewed",
      },
    });
    const request = {
      projectId: "project-1",
      sceneId: "scene-1",
      entityIds: ["entity-1"],
      relationIds: ["relation-1"],
      proposalKey: "review-1",
    };
    const binding = {
      authorityId: "authority-1",
      generation: 1,
      authorityInstanceId: "1",
    };

    await prepareNir1EntityRelationRevision(request, binding);

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_prepare",
      { payload: request, workspaceBinding: binding },
    );
  });

  it("reads the dedicated current typed projection by review Run", async () => {
    h.invoke.mockResolvedValueOnce({
      status: "draft",
      result: { revisionId: "revision-1" },
    });
    const request = {
      expectedWorkspacePath: "/workspace/project-1",
      projectId: "project-1",
      runId: "run-1",
    };

    await readCurrentNir1EntityRelationRevision(request);

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_read_current",
      request,
    );
  });

  it("restores a target through the Native typed-family lookup", async () => {
    h.invoke.mockResolvedValueOnce({
      runId: "run-a",
      response: {
        status: "unavailable",
        result: { reason: "source-revision-changed" },
      },
    });
    const request = {
      expectedWorkspacePath: "/workspace/project-1",
      projectId: "project-1",
      entityId: "entity-a",
      relationId: "relation-a",
    };

    await restoreNir1EntityRelationRevision(request);

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "nir1_entity_relation_revision_restore",
      request,
    );
  });

  it("uses the existing explicit human Decision route for typed review", async () => {
    h.invoke.mockResolvedValueOnce({
      decisionId: "decision-1",
      proposalId: "proposal-1",
      revisionId: "revision-1",
      decision: "approved",
      status: "approved",
    });

    await decideNir1EntityRelationRevision({
      runId: "run-1",
      projectId: "project-1",
      proposalId: "proposal-1",
      revisionId: "revision-1",
      decision: "approved",
    });

    expect(h.invoke).toHaveBeenCalledExactlyOnceWith(
      "narrative_extraction_append_human_decision",
      {
        payload: {
          runId: "run-1",
          projectId: "project-1",
          proposalId: "proposal-1",
          revisionId: "revision-1",
          decision: "approved",
          createdBy: "nir1-entity-relation-review",
        },
      },
    );
  });
});
