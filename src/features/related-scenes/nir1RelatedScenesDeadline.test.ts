import { describe, expect, it } from "vitest";
import { createNir1RelatedScenesDeadline } from "./nir1RelatedScenesDeadline";

const snapshot = { indexUsable: true, querySupported: true };
const create = (additionalWaitMs = 10.84) =>
  createNir1RelatedScenesDeadline({
    rawReadyAtMs: 100,
    additionalWaitMs,
    snapshot,
  });

describe("NIR1 renderer completion deadline", () => {
  it("uses actual Raw ready plus the supplied fixed wait budget as an absolute deadline", () => {
    const deadline = create();
    expect(deadline.rawReadyAtMs).toBe(100);
    expect(deadline.deadlineAtMs).toBe(110.84);
    expect(deadline.remainingMs(104)).toBeCloseTo(6.84);
    expect(deadline.remainingMs(115)).toBe(0);
  });

  it("does not restart the deadline on IPC arrival or a repeated wait", () => {
    const deadline = create();
    expect(deadline.remainingMs(109)).toBeCloseTo(1.84);
    expect(deadline.remainingMs(110)).toBeCloseTo(0.84);
    expect(deadline.completeIr(111)?.outcome).toBe("timeout");
    expect(deadline.completion?.completedAtMs).toBe(111);
  });

  it("accepts IR before the deadline and claims final completion once", () => {
    const deadline = create();
    const completion = deadline.completeIr(105);
    expect(completion).toMatchObject({
      outcome: "ir-ready",
      completedAtMs: 105,
      timeoutDenominator: true,
      snapshot,
    });
    expect(deadline.completeIr(106)).toBeNull();
    expect(deadline.expire(120)).toBeNull();
    expect(deadline.stop("cancelled", 121)).toBeNull();
    expect(deadline.completion).toBe(completion);
  });

  it("expires at the deadline and discards late IR for the same query", () => {
    const deadline = create();
    expect(deadline.expire(110)).toBeNull();
    expect(deadline.expire(110.84)?.outcome).toBe("timeout");
    expect(deadline.completeIr(111)).toBeNull();
    expect(deadline.completion?.outcome).toBe("timeout");
  });

  it("checks monotonic time when IR arrives even if a delayed timer has not fired", () => {
    const deadline = create();
    expect(deadline.completeIr(120)?.outcome).toBe("timeout");
    expect(deadline.expire(120)).toBeNull();
  });

  it("does not wait when the supplied budget is zero", () => {
    const deadline = create(0);
    expect(deadline.completeIr(100)?.outcome).toBe("timeout");
  });

  it.each(["cancelled", "invalidated", "ir-unavailable", "failed"] as const)(
    "keeps initially usable calls in the denominator after %s",
    (reason) => {
      const deadline = create();
      const completion = deadline.stop(reason, 105);
      expect(completion).toMatchObject({
        outcome: reason,
        timeoutDenominator: true,
        snapshot,
      });
      expect(deadline.completeIr(106)).toBeNull();
    },
  );

  it("takes an immutable copy of the backend coherent initial snapshot", () => {
    const supplied = { indexUsable: true, querySupported: true };
    const deadline = createNir1RelatedScenesDeadline({
      rawReadyAtMs: 100,
      additionalWaitMs: 10.84,
      snapshot: supplied,
    });
    supplied.indexUsable = false;
    supplied.querySupported = false;
    const completion = deadline.stop("invalidated", 104);
    expect(completion?.snapshot).toEqual({
      indexUsable: true,
      querySupported: true,
    });
    expect(completion?.timeoutDenominator).toBe(true);
    expect(Object.isFrozen(completion?.snapshot)).toBe(true);
  });

  it.each([
    { indexUsable: false, querySupported: true },
    { indexUsable: true, querySupported: false },
    { indexUsable: false, querySupported: false },
  ])(
    "does not count unsupported/unusable initial calls in the timeout denominator: %j",
    (initial) => {
      const deadline = createNir1RelatedScenesDeadline({
        rawReadyAtMs: 100,
        additionalWaitMs: 10.84,
        snapshot: initial,
      });
      expect(deadline.stop("ir-unavailable", 104)?.timeoutDenominator).toBe(
        false,
      );
    },
  );

  it.each([-1, Infinity, NaN])(
    "rejects an invalid wait budget: %s",
    (additionalWaitMs) => {
      expect(() => create(additionalWaitMs)).toThrow();
    },
  );
});

describe("NIR1 deadline accounting across stopped outcomes", () => {
  const reasons = [
    "cancelled",
    "invalidated",
    "ir-unavailable",
    "failed",
  ] as const;
  const boundaries = [
    { time: 110.83, exceeded: false },
    { time: 110.84, exceeded: true },
    { time: 120, exceeded: true },
  ];

  for (const reason of reasons) {
    it.each(boundaries)(
      `preserves ${reason} while accounting for deadline at $time`,
      ({ time, exceeded }) => {
        const deadline = create();
        expect(deadline.stop(reason, time)).toMatchObject({
          outcome: reason,
          completedAtMs: time,
          timeoutDenominator: true,
          deadlineExceeded: exceeded,
          timeoutNumerator: exceeded,
        });
      },
    );
  }

  it.each(["ir-unavailable", "failed"] as const)(
    "records a late %s in the numerator before a delayed timer runs",
    (reason) => {
      const deadline = create();
      const completion = deadline.stop(reason, 120);
      expect(completion).toMatchObject({
        outcome: reason,
        deadlineExceeded: true,
        timeoutNumerator: true,
      });
      expect(deadline.expire(125)).toBeNull();
      expect(deadline.completeIr(126)).toBeNull();
      expect(deadline.completion).toBe(completion);
      expect(Object.isFrozen(completion)).toBe(true);
    },
  );

  it.each([
    { indexUsable: false, querySupported: true },
    { indexUsable: true, querySupported: false },
    { indexUsable: false, querySupported: false },
  ])(
    "keeps late excluded calls visible without entering the usable timeout rate: %j",
    (initial) => {
      const deadline = createNir1RelatedScenesDeadline({
        rawReadyAtMs: 100,
        additionalWaitMs: 10.84,
        snapshot: initial,
      });
      expect(deadline.stop("failed", 120)).toMatchObject({
        outcome: "failed",
        deadlineExceeded: true,
        timeoutDenominator: false,
        timeoutNumerator: false,
      });
    },
  );

  it("keeps timely completion outside the numerator after subsequent late notifications", () => {
    const deadline = create();
    const completion = deadline.completeIr(105);
    expect(completion).toMatchObject({
      outcome: "ir-ready",
      deadlineExceeded: false,
      timeoutNumerator: false,
    });
    expect(deadline.stop("failed", 120)).toBeNull();
    expect(deadline.expire(121)).toBeNull();
    expect(deadline.completion).toBe(completion);
  });

  it.each(["timer", "ir"] as const)(
    "records deadline expiry through %s completion",
    (arrival) => {
      const deadline = create();
      const completion =
        arrival === "timer"
          ? deadline.expire(110.84)
          : deadline.completeIr(110.84);
      expect(completion).toMatchObject({
        outcome: "timeout",
        deadlineExceeded: true,
        timeoutDenominator: true,
        timeoutNumerator: true,
      });
    },
  );
});
