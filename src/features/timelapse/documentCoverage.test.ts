// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, dbSelectMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/db/client", () => ({ db: { select: dbSelectMock } }));

import {
  _resetRecorderForTests,
  beginWorkspaceSwitch,
  endWorkspaceSwitch,
  flushNow,
  initRecorderForProject,
  claimTimelapseDocStepCoverage,
  recordChangeEvent,
  setRecorderEnabled,
} from "./recorder";
import {
  acquireTimelapseReplacementFence,
  isTimelapseReplacementFenceActiveForDocument,
} from "./documentCoverage";
import type { TimelapseDocumentRef } from "./documentCoverage";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { _resetQuiescenceLeasesForTests } from "@/application/lifecycle/quiescenceLease";
import { acquireQuiescenceLease } from "@/application/lifecycle/quiescenceLease";

interface EventArg {
  opType: string;
  domain: string;
  entityId: string | null;
  payload: string;
}

function acceptedDocument(
  receipt: { document?: TimelapseDocumentRef } | null,
): TimelapseDocumentRef {
  if (receipt?.document === undefined) {
    throw new Error("expected an accepted doc.step receipt");
  }
  return receipt.document;
}

describe("document coverage and replacement fences", () => {
  let appended: EventArg[];

  beforeEach(() => {
    vi.clearAllMocks();
    appended = [];
    dbSelectMock.mockImplementation(() => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
    }));
    invokeMock.mockImplementation(
      async (_command: string, args: { events: EventArg[] }) => {
        appended.push(...args.events);
        return { tailSequence: appended.length };
      },
    );
    _resetRecorderForTests();
    _resetQuiescenceLeasesForTests();
    setRecorderEnabled(true);
    publishCurrentProjectId(null);
    setCurrentWorkspaceIdentity(null);
  });

  async function bind(projectId = "project-1"): Promise<void> {
    publishCurrentProjectId(projectId);
    await initRecorderForProject(projectId);
  }

  function step(
    projectId: string,
    entityId: string,
    documentStorage?: "database" | "file",
  ) {
    return recordChangeEvent({
      domain: "editor",
      opType: "doc.step",
      projectId,
      entityType: "scene",
      entityId,
      ...(documentStorage ? { documentStorage } : {}),
      payload: { steps: [{ stepType: "replace" }] },
    });
  }

  it("requires a non-empty accepted doc.step prefix", async () => {
    await bind();
    const metadata = recordChangeEvent({
      domain: "editor",
      opType: "selection.move",
      projectId: "project-1",
      entityType: "scene",
      entityId: "scene-1",
      payload: {},
    });
    expect(metadata?.document).toBeUndefined();
    expect(claimTimelapseDocStepCoverage(metadata as never)).toBeNull();
    expect(
      claimTimelapseDocStepCoverage(
        step("other-project", "scene-1")?.document as never,
      ),
    ).toBeNull();
  });

  it("does not accept disabled, wrong-project, or destructive-lifecycle steps", async () => {
    await bind();
    setRecorderEnabled(false);
    expect(step("project-1", "scene-1")).toBeNull();
    setRecorderEnabled(true);
    await bind();
    expect(step("other-project", "scene-1")).toBeNull();
    const lease = acquireQuiescenceLease("data-delete");
    expect(step("project-1", "scene-1")).toBeNull();
    lease.release();
  });

  it("breaks an epoch when queued payload serialization fails", async () => {
    await bind();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const receipt = recordChangeEvent({
      domain: "editor",
      opType: "doc.step",
      projectId: "project-1",
      entityType: "scene",
      entityId: "scene-1",
      payload: circular,
    });
    await expect(flushNow()).rejects.toThrow();
    expect(claimTimelapseDocStepCoverage(acceptedDocument(receipt))).toBeNull();
  });

  it("materializes one exact digest payload and keeps suffix behind commit", async () => {
    await bind();
    const first = step("project-1", "scene-1");
    const claim = claimTimelapseDocStepCoverage(acceptedDocument(first));
    expect(claim).not.toBeNull();
    step("project-1", "scene-1");

    const proof = await claim!.materialize("body-A");
    expect(proof.contentDigest).toBe(
      "sha256:b4327fed7e08a4477a72e8ebbda3891e9d30c6aac757ee76223562d9b6da2e95",
    );
    expect(appended.map((event) => event.opType)).toEqual([
      "doc.step",
      "doc.step.coverage",
    ]);
    expect(JSON.parse(appended[1]!.payload)).toEqual({
      resultContentDigest: proof.contentDigest,
    });
    await flushNow();
    expect(appended).toHaveLength(2);
    claim!.commit();
    await flushNow();
    expect(appended.map((event) => event.opType)).toEqual([
      "doc.step",
      "doc.step.coverage",
      "doc.step",
    ]);
  });

  it("serializes cross-document claims through one global coverage chain", async () => {
    await bind();
    const a = step("project-1", "scene-a");
    const b = step("project-1", "scene-b");
    const claimA = claimTimelapseDocStepCoverage(acceptedDocument(a));
    const claimB = claimTimelapseDocStepCoverage(acceptedDocument(b));
    expect(claimA).not.toBeNull();
    expect(claimB).not.toBeNull();

    let bSettled = false;
    const proofA = claimA!.materialize("A");
    const proofB = claimB!.materialize("B");
    void proofB.then(() => {
      bSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bSettled).toBe(false);

    await proofA;
    claimA!.commit();
    await proofB;
    claimB!.commit();
    expect(appended.map((event) => event.opType)).toEqual([
      "doc.step",
      "doc.step",
      "doc.step.coverage",
      "doc.step.coverage",
    ]);
  });

  it("rejects same-document overlap and releases lifecycle barriers", async () => {
    await bind();
    const first = step("project-1", "scene-1");
    const claim = claimTimelapseDocStepCoverage(acceptedDocument(first));
    expect(claimTimelapseDocStepCoverage(acceptedDocument(first))).toBeNull();
    beginWorkspaceSwitch();
    expect(claimTimelapseDocStepCoverage(acceptedDocument(first))).toBeNull();
    claim!.cancel();
    endWorkspaceSwitch({ restoreBinding: true });
    setRecorderEnabled(false);
    expect(step("project-1", "scene-1")).toBeNull();
  });

  it("publishes a document fence before await and does not poison the epoch", async () => {
    await bind();
    const fence = acquireTimelapseReplacementFence({
      projectId: "project-1",
      document: {
        projectId: "project-1",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-1",
        storage: "file",
      },
    });
    expect(
      isTimelapseReplacementFenceActiveForDocument("project-1", {
        kind: "tree",
        id: "scene-1",
        storage: "file",
      }),
    ).toBe(true);
    expect(step("project-1", "scene-1", "file")).toBeNull();
    fence.release();
    expect(
      isTimelapseReplacementFenceActiveForDocument("project-1", {
        kind: "tree",
        id: "scene-1",
        storage: "file",
      }),
    ).toBe(false);
    expect(step("project-1", "scene-1", "file")?.document).toBeDefined();
  });
});
