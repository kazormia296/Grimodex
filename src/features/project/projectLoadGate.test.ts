import { describe, it, expect, beforeEach } from "vitest";
import {
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
});
