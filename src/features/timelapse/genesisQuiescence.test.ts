import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  canScheduleQuiescenceMutation,
  isQuiescenceLeaseActive,
  type QuiescenceLeaseReason,
} from "@/application/lifecycle/quiescenceLease";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
  registerTimelapseGenesisRetry,
} from "./genesisBarrier";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "./genesisQuiescence";

const REASONS: QuiescenceLeaseReason[] = [
  "project-load",
  "workspace-open",
  "workspace-restore",
  "data-delete",
  "window-close",
  "audit-export",
  "narrative-snapshot",
];

beforeEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetTimelapseGenesisBarriersForTests();
  publishCurrentProjectId("project-1");
});

afterEach(() => {
  publishCurrentProjectId(null);
});

describe("genesis-safe production quiescence entry", () => {
  it.each(REASONS)(
    "keeps Native reads open until slow genesis settles for %s",
    async (reason) => {
      const genesis = beginTimelapseGenesisBarrier("project-1");
      const leasePromise = acquireQuiescenceLeaseAfterTimelapseGenesis(reason);

      await Promise.resolve();
      expect(isQuiescenceLeaseActive(reason)).toBe(false);
      expect(canScheduleQuiescenceMutation()).toBe(false);

      genesis.complete();
      const lease = await leasePromise;
      expect(isQuiescenceLeaseActive(reason)).toBe(true);
      lease.release();
    },
  );

  it("retries a failed current genesis before acquiring the lease", async () => {
    const failed = beginTimelapseGenesisBarrier("project-1");
    failed.fail(new Error("read cancelled"));
    const retry = vi.fn(async () => {
      const next = beginTimelapseGenesisBarrier("project-1");
      next.complete();
    });
    const unregister = registerTimelapseGenesisRetry(retry);

    const lease =
      await acquireQuiescenceLeaseAfterTimelapseGenesis("audit-export");
    expect(retry).toHaveBeenCalledOnce();
    lease.release();
    unregister();
  });
});
