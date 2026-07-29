import { describe, it, expect, beforeEach } from "vitest";
import {
  acquireWorkspaceProjectLoadLease,
  isProjectLoading,
  withProjectLoad,
  whenProjectLoadDone,
  resetProjectLoadGateForTests,
} from "./projectLoadGate";

describe("projectLoadGate", () => {
  beforeEach(() => {
    resetProjectLoadGateForTests();
  });

  it("tracks nested project loads", async () => {
    expect(isProjectLoading()).toBe(false);

    await withProjectLoad(async () => {
      expect(isProjectLoading()).toBe(true);
      await withProjectLoad(async () => {
        expect(isProjectLoading()).toBe(true);
      });
      expect(isProjectLoading()).toBe(true);
    });

    expect(isProjectLoading()).toBe(false);
  });

  it("resolves waiters after the outer load completes", async () => {
    let notified = false;

    const load = withProjectLoad(async () => {
      void whenProjectLoadDone().then(() => {
        notified = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(notified).toBe(false);
    await load;
    await Promise.resolve();
    expect(notified).toBe(true);
  });

  it("invalidates and drains an existing load before granting a Workspace lease", async () => {
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const invalidated: string[] = [];
    const load = withProjectLoad(async () => {
      invalidated.push("load-started");
      await loadGate;
      invalidated.push("load-finished");
    });
    await Promise.resolve();

    let leaseGranted = false;
    const leasePromise = acquireWorkspaceProjectLoadLease(() => {
      invalidated.push("invalidated");
    }).then((lease) => {
      leaseGranted = true;
      return lease;
    });
    await Promise.resolve();

    expect(invalidated).toEqual(["load-started", "invalidated"]);
    expect(leaseGranted).toBe(false);

    releaseLoad();
    await load;
    const lease = await leasePromise;
    expect(leaseGranted).toBe(true);
    expect(invalidated).toEqual([
      "load-started",
      "invalidated",
      "load-finished",
    ]);
    lease.release();
  });

  it("does not start a new Project load until the Workspace lease is released", async () => {
    const lease = await acquireWorkspaceProjectLoadLease(() => {});
    let started = false;
    const load = withProjectLoad(async () => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);

    lease.release();
    await load;
    expect(started).toBe(true);
  });

  it("allows only the Workspace-owned context to hydrate before publication", async () => {
    const lease = await acquireWorkspaceProjectLoadLease(() => {});
    const events: string[] = [];
    const queued = withProjectLoad(async () => {
      events.push("queued-project");
    });

    await withProjectLoad(async (context) => {
      expect(context).toBe(lease.projectLoadContext);
      expect(context.owner).toBe("workspace");
      events.push("workspace-hydrate");
    }, lease.projectLoadContext);
    await Promise.resolve();
    expect(events).toEqual(["workspace-hydrate"]);
    expect(isProjectLoading()).toBe(true);

    lease.release();
    await queued;
    expect(events).toEqual(["workspace-hydrate", "queued-project"]);
    expect(isProjectLoading()).toBe(false);
  });

  it("allows an existing lifecycle to finish a nested phase after Workspace acquisition", async () => {
    let enterNested!: () => void;
    const nestedGate = new Promise<void>((resolve) => {
      enterNested = resolve;
    });
    const events: string[] = [];
    const load = withProjectLoad(async (context) => {
      events.push("outer-started");
      await nestedGate;
      await withProjectLoad(async () => {
        events.push("nested-finished");
      }, context);
    });
    await Promise.resolve();

    const leasePromise = acquireWorkspaceProjectLoadLease(() => {
      events.push("invalidated");
    });
    await Promise.resolve();
    enterNested();
    await load;
    const lease = await leasePromise;

    expect(events).toEqual(["outer-started", "invalidated", "nested-finished"]);
    lease.release();
  });
});
