import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
  canScheduleQuiescenceMutation,
  isQuiescenceLeaseActive,
} from "@/application/lifecycle/quiescenceLease";
import {
  enqueueIpc,
  resetIpcQueueForTests,
  type IpcQueueCategory,
} from "@/lib/ipcQueue";
import {
  captureAiAuditExportIdentity,
  isAiAuditFrozenReadProof,
  runAiAuditExportBoundary,
  type AiAuditExportBoundaryOverrides,
  type AiAuditExportIdentity,
} from "./exportBoundary";
import {
  _resetPendingAiAuditExecutionsForTests,
  completePendingAiAuditExecution,
  reservePendingAiAuditExecution,
} from "./executionRegistry";

const IDENTITY: AiAuditExportIdentity = {
  projectId: "project-1",
  workspace: { path: "/novels/award-entry", openRevision: 7 },
};

function identityDependencies(): AiAuditExportBoundaryOverrides {
  return {
    getLoadedProjectId: () => IDENTITY.projectId,
    getCurrentWorkspaceIdentity: () => ({ ...IDENTITY.workspace }),
  };
}

afterEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetPendingAiAuditExecutionsForTests();
  resetIpcQueueForTests();
});

describe("AI audit export boundary", () => {
  it("captures the exact Project and Workspace revision selected by the click", () => {
    expect(
      captureAiAuditExportIdentity("project-1", identityDependencies()),
    ).toEqual(IDENTITY);
  });

  it("waits for strict quiescence before the first read and freezes every report and ledger high-water read", async () => {
    let resolveFlush!: () => void;
    let auditDrain = 0;
    let ipcDrain = 0;
    const order: string[] = [];
    const frozenStages = [
      "authorship",
      "provenance",
      "legacy-evidence",
      "project-high-water",
      "workspace-high-water",
    ];
    const readFrozenState = vi.fn(async () => {
      for (const stage of frozenStages) {
        expect(canScheduleQuiescenceMutation(), stage).toBe(false);
        order.push(stage);
      }
      await expect(
        enqueueIpc("db_execute", async () => "readable", 10_000, "read"),
      ).resolves.toBe("readable");
      await expect(
        enqueueIpc(
          "semantic_search",
          async () => "must not run",
          10_000,
          "read",
        ),
      ).rejects.toThrow("IPC_READ_CANCELLED");
      await expect(
        enqueueIpc(
          "semantic_index_scene",
          async () => "must not run",
          null,
          "derived",
        ),
      ).rejects.toThrow("IPC_DERIVED_CANCELLED");
      await expect(
        enqueueIpc("save_scene", async () => "must not run", null, "mutation"),
      ).rejects.toThrow("IPC_MUTATION_CANCELLED");
      expect(() => acquireQuiescenceLease("project-load")).toThrow(
        "Cannot start project-load while an audit export is active",
      );
      expect(() => acquireQuiescenceLease("workspace-open")).toThrow(
        "Cannot start workspace-open while an audit export is active",
      );
      return "bundle";
    });

    const task = runAiAuditExportBoundary(IDENTITY, readFrozenState, {
      ...identityDependencies(),
      awaitPendingAiAuditExecutions: vi.fn(async () => {
        auditDrain += 1;
        order.push(`audit-drain-${auditDrain}`);
      }),
      awaitPendingIpcActualTasks: vi.fn(async () => {
        ipcDrain += 1;
        order.push(`ipc-drain-${ipcDrain}`);
      }),
      flushStrictQuiescence: () =>
        new Promise<void>((resolve) => {
          order.push("flush-start");
          resolveFlush = resolve;
        }),
    });

    await vi.waitFor(() =>
      expect(order).toEqual([
        "audit-drain-1",
        "ipc-drain-1",
        "audit-drain-2",
        "flush-start",
      ]),
    );
    expect(readFrozenState).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(true);
    expect(canScheduleQuiescenceMutation()).toBe(false);
    await expect(
      enqueueIpc("audit-read-before-flush", async () => null, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");

    order.push("flush-complete");
    resolveFlush();
    await expect(task).resolves.toBe("bundle");

    expect(order).toEqual([
      "audit-drain-1",
      "ipc-drain-1",
      "audit-drain-2",
      "flush-start",
      "flush-complete",
      "audit-drain-3",
      "ipc-drain-2",
      "audit-drain-4",
      ...frozenStages,
    ]);
    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(canScheduleQuiescenceMutation()).toBe(true);
  });

  it("drains a mutation scheduled by strict-flush completion before admitting the first safe read", async () => {
    let resolveSlippedMutation!: () => void;
    const slippedActual = new Promise<void>((resolve) => {
      resolveSlippedMutation = resolve;
    });
    const readFrozenState = vi.fn(async () => "bundle");

    const task = runAiAuditExportBoundary(IDENTITY, readFrozenState, {
      ...identityDependencies(),
      flushStrictQuiescence: vi.fn(async () => {
        void enqueueIpc(
          "strict-flush-tail-mutation",
          () => slippedActual,
          null,
          "mutation",
        );
      }),
    });

    await Promise.resolve();
    expect(readFrozenState).not.toHaveBeenCalled();
    resolveSlippedMutation();
    await expect(task).resolves.toBe("bundle");
    expect(readFrozenState).toHaveBeenCalledOnce();
  });

  it("retains a strict-flush tail-task failure that settles before the final drain snapshots it", async () => {
    const readFrozenState = vi.fn(async () => "must not publish");

    await expect(
      runAiAuditExportBoundary(IDENTITY, readFrozenState, {
        ...identityDependencies(),
        flushStrictQuiescence: vi.fn(async () => {
          void enqueueIpc(
            "strict-flush-tail-failure",
            async () => {
              throw new Error("tail mutation failed before final drain");
            },
            null,
            "mutation",
          ).catch(() => undefined);
          await Promise.resolve();
          await Promise.resolve();
        }),
      }),
    ).rejects.toThrow("tail mutation failed before final drain");

    expect(readFrozenState).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(false);
  });

  it("revokes each frozen-read proof as soon as its boundary callback settles", async () => {
    let capturedProof: unknown;

    await expect(
      runAiAuditExportBoundary(
        IDENTITY,
        vi.fn(async (proof) => {
          capturedProof = proof;
          expect(isAiAuditFrozenReadProof(proof)).toBe(true);
          return "bundle";
        }),
        {
          ...identityDependencies(),
          flushStrictQuiescence: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toBe("bundle");

    expect(isAiAuditFrozenReadProof(capturedProof)).toBe(false);
  });

  it("waits a pre-click audited stream through its durable terminal before flushing or reading", async () => {
    reservePendingAiAuditExecution("stream-execution");
    const flush = vi.fn(async () => undefined);
    const readFrozenState = vi.fn(async () => "bundle");

    const task = runAiAuditExportBoundary(IDENTITY, readFrozenState, {
      ...identityDependencies(),
      awaitPendingIpcActualTasks: vi.fn(async () => undefined),
      flushStrictQuiescence: flush,
    });

    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    expect(readFrozenState).not.toHaveBeenCalled();
    expect(canScheduleQuiescenceMutation()).toBe(false);

    completePendingAiAuditExecution("stream-execution");
    await expect(task).resolves.toBe("bundle");
    expect(flush).toHaveBeenCalledOnce();
    expect(readFrozenState).toHaveBeenCalledOnce();
  });

  it("retains and drains pre-existing native read/derived callers while rejecting new ones", async () => {
    let resolveRead!: () => void;
    let resolveDerived!: () => void;
    const readActual = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
    const derivedActual = new Promise<void>((resolve) => {
      resolveDerived = resolve;
    });
    const existingRead = enqueueIpc(
      "preexisting-audited-read",
      () => readActual.then(() => "read-finished"),
      10_000,
      "read",
    );
    const existingDerived = enqueueIpc(
      "preexisting-semantic-inference",
      () => derivedActual.then(() => "derived-finished"),
      null,
      "derived",
    );
    const flush = vi.fn(async () => undefined);
    const readFrozenState = vi.fn(async () => "bundle");

    const task = runAiAuditExportBoundary(IDENTITY, readFrozenState, {
      ...identityDependencies(),
      flushStrictQuiescence: flush,
    });

    await Promise.resolve();
    await expect(
      enqueueIpc("new-read", async () => null, 10_000, "read"),
    ).rejects.toThrow("IPC_READ_CANCELLED");
    await expect(
      enqueueIpc("new-derived", async () => null, null, "derived"),
    ).rejects.toThrow("IPC_DERIVED_CANCELLED");
    expect(flush).not.toHaveBeenCalled();
    expect(readFrozenState).not.toHaveBeenCalled();

    resolveRead();
    resolveDerived();
    await expect(existingRead).resolves.toBe("read-finished");
    await expect(existingDerived).resolves.toBe("derived-finished");
    await expect(task).resolves.toBe("bundle");
    expect(flush).toHaveBeenCalledOnce();
    expect(readFrozenState).toHaveBeenCalledOnce();
  });

  it.each<IpcQueueCategory>(["mutation", "read", "derived"])(
    "fails closed when a pre-existing %s IPC actual task fails",
    async (category) => {
      let rejectActual!: (error: Error) => void;
      let actualStarted = false;
      const actual = new Promise<never>((_resolve, reject) => {
        rejectActual = reject;
      });
      const caller = enqueueIpc(
        `preexisting-failing-${category}`,
        () => {
          actualStarted = true;
          return actual;
        },
        null,
        category,
      );
      const callerFailure = caller.catch((error: unknown) => error);
      await vi.waitFor(() => expect(actualStarted).toBe(true));
      const readFrozenState = vi.fn(async () => "must not publish");

      const exportTask = runAiAuditExportBoundary(IDENTITY, readFrozenState, {
        ...identityDependencies(),
        flushStrictQuiescence: vi.fn(async () => undefined),
      });
      rejectActual(new Error(`${category} actual task failed`));

      await expect(exportTask).rejects.toThrow(
        `${category} actual task failed`,
      );
      await expect(callerFailure).resolves.toMatchObject({
        message: `${category} actual task failed`,
      });
      expect(readFrozenState).not.toHaveBeenCalled();
      expect(isQuiescenceLeaseActive()).toBe(false);
      expect(canScheduleQuiescenceMutation()).toBe(true);
    },
  );

  it("does not start any export read when strict quiescence fails and always releases", async () => {
    const readFrozenState = vi.fn(async () => "partial bundle");

    await expect(
      runAiAuditExportBoundary(IDENTITY, readFrozenState, {
        ...identityDependencies(),
        flushStrictQuiescence: vi.fn(async () => {
          throw new Error("autosave flush failed");
        }),
      }),
    ).rejects.toThrow("autosave flush failed");

    expect(readFrozenState).not.toHaveBeenCalled();
    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(canScheduleQuiescenceMutation()).toBe(true);
  });

  it("releases after a report or ledger read fails", async () => {
    await expect(
      runAiAuditExportBoundary(
        IDENTITY,
        vi.fn(async () => {
          expect(canScheduleQuiescenceMutation()).toBe(false);
          throw new Error("ledger read failed");
        }),
        {
          ...identityDependencies(),
          flushStrictQuiescence: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("ledger read failed");

    expect(isQuiescenceLeaseActive()).toBe(false);
    expect(canScheduleQuiescenceMutation()).toBe(true);
  });

  it("fails closed if the frozen Project or Workspace identity changes before publication", async () => {
    let workspaceRevision = IDENTITY.workspace.openRevision;

    await expect(
      runAiAuditExportBoundary(
        IDENTITY,
        vi.fn(async () => {
          workspaceRevision += 1;
          return "must not publish";
        }),
        {
          getLoadedProjectId: () => IDENTITY.projectId,
          getCurrentWorkspaceIdentity: () => ({
            ...IDENTITY.workspace,
            openRevision: workspaceRevision,
          }),
          flushStrictQuiescence: vi.fn(async () => undefined),
        },
      ),
    ).rejects.toThrow("AI_AUDIT_EXPORT_IDENTITY_CHANGED");

    expect(isQuiescenceLeaseActive()).toBe(false);
  });
});
