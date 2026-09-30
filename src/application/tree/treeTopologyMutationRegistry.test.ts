import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  _resetTreeTopologyMutationRegistryForTests,
  tryAcquireTreeTopologyMutationLease,
  waitForTreeTopologyMutationsIdle,
} from "./treeTopologyMutationRegistry";

describe("treeTopologyMutationRegistry", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    _resetTreeTopologyMutationRegistryForTests();
  });

  afterEach(() => {
    _resetTreeTopologyMutationRegistryForTests();
    _resetQuiescenceLeasesForTests();
  });

  it("drains a topology writer admitted before a narrative snapshot", async () => {
    const topology = tryAcquireTreeTopologyMutationLease();
    const narrative = acquireQuiescenceLease("narrative-snapshot");
    let idle = false;
    const drain = waitForTreeTopologyMutationsIdle().then(() => {
      idle = true;
    });

    await Promise.resolve();
    expect(idle).toBe(false);
    expect(tryAcquireTreeTopologyMutationLease()).toBeNull();

    topology?.release();
    await drain;
    expect(idle).toBe(true);
    narrative.release();
  });
});
