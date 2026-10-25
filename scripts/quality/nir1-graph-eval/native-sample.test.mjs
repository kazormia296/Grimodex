import assert from "node:assert/strict";
import { test } from "node:test";
import {
  freshnessStampFromNative,
  nativeDurationMs,
  nativeNs,
  recordReadFromA3,
  sampleFieldsFromNativeRecord,
} from "./native-sample.mjs";

test("DR-CP4-S1C1-10: nativeNs accepts only non-negative safe integer ns", () => {
  assert.equal(nativeNs(0), 0);
  assert.equal(nativeNs(1_234_567_890), 1_234_567_890);
  assert.equal(nativeNs("1234567890"), 1_234_567_890);
  // A ms value (or any converted value) is a fraction: refused.
  assert.throws(() => nativeNs(12.5), /integer ns/);
  assert.throws(() => nativeNs(1_234_567_890 / 1e6), /integer ns/);
  assert.throws(() => nativeNs(-1), /integer ns/);
  assert.throws(() => nativeNs(2 ** 53), /integer ns/);
  assert.throws(() => nativeNs("9007199254740993"), /safe integer/);
  for (const text of ["1e9", "-5", "+5", "05", "1.0", " 5", ""])
    assert.throws(() => nativeNs(text), /decimal ns/);
  assert.throws(() => nativeNs(null), /integer ns/);
});

test("nativeDurationMs divides ns by 1e6 and only for disclosure", () => {
  assert.equal(nativeDurationMs(1_000_000, 3_500_000), 2.5);
  assert.equal(nativeDurationMs("0", "10840000"), 10.84);
  assert.throws(() => nativeDurationMs(5, 4), /ends before/);
});

const stamp = (result, matched, attemptedAtNs = 42) => ({
  result,
  matched,
  attemptedAtNs,
});

test("freshness stamps keep result and matched consistent with the Native", () => {
  assert.deepEqual(freshnessStampFromNative(stamp("fresh", true)), {
    result: "fresh",
    matched: true,
    attemptedAtNs: 42,
  });
  assert.equal(freshnessStampFromNative(stamp("stale", false)).matched, false);
  assert.equal(
    freshnessStampFromNative(stamp("unavailable", null)).matched,
    null,
  );
  assert.equal(
    freshnessStampFromNative(stamp("stamp0-missing", null)).result,
    "stamp0-missing",
  );
  assert.equal(freshnessStampFromNative(null), null);
  assert.throws(
    () => freshnessStampFromNative(stamp("unavailable", false)),
    /matched=null/,
  );
  assert.throws(
    () => freshnessStampFromNative(stamp("fresh", null)),
    /matched=true/,
  );
  assert.throws(() => freshnessStampFromNative(stamp("busy", null)), /unknown/);
  assert.throws(
    () => freshnessStampFromNative(stamp("fresh", true, 4.2)),
    /integer ns/,
  );
});

function record(overrides = {}) {
  return {
    seq: 1,
    tBeginNs: 100,
    tReturnedNs: 150,
    startSlot: {
      kind: "ready",
      readyFresh: true,
      preparesReady: 3,
      readyGeneration: 3,
    },
    cacheOccupiedAtBegin: false,
    begin: "pending",
    reason: null,
    busyCause: null,
    ticket: {
      tTicketNs: 120,
      settled: true,
      tSettledNs: 900,
      outcome: "available",
      reason: null,
      disposition: "used",
      busyCause: null,
      freshnessStamp: stamp("fresh", true, 130),
    },
    ...overrides,
  };
}

test("a pending worker record maps to the S1a table", () => {
  const fields = sampleFieldsFromNativeRecord(record());
  assert.deepEqual(fields.startSlot, {
    kind: "ready",
    readyFresh: true,
    preparesReady: 3,
    readyGeneration: 3,
  });
  assert.equal(fields.source, "worker");
  assert.equal(fields.busyCause, null);
  assert.deepEqual(fields.freshnessStamp, {
    result: "fresh",
    matched: true,
    attemptedAtNs: 130,
  });
  assert.deepEqual(fields.timing, { beginNs: 100, returnedNs: 150 });
  assert.equal(fields.ticket.settledNs, 900);
});

test("Busy causes come from the begin or the ticket, never both", () => {
  const begin = sampleFieldsFromNativeRecord(
    record({
      begin: "unavailable",
      reason: "busy",
      busyCause: "in-use",
      ticket: null,
    }),
  );
  assert.equal(begin.busyCause, "in-use");
  assert.equal(begin.source, null);
  const ticket = sampleFieldsFromNativeRecord(
    record({
      ticket: {
        ...record().ticket,
        outcome: "unavailable",
        reason: "busy",
        busyCause: "worker-capacity",
        disposition: "unused",
      },
    }),
  );
  assert.equal(ticket.busyCause, "worker-capacity");
  assert.equal(ticket.source, null);
  // The stamp-read Busy is not a Native cause.
  assert.throws(
    () =>
      sampleFieldsFromNativeRecord(
        record({
          ticket: {
            ...record().ticket,
            outcome: "unavailable",
            reason: "busy",
            busyCause: "freshness-stamp-read-failed",
          },
        }),
      ),
    /unknown ticket Busy cause/,
  );
  assert.throws(
    () =>
      sampleFieldsFromNativeRecord(
        record({
          begin: "unavailable",
          reason: "stale",
          busyCause: "in-use",
          ticket: null,
        }),
      ),
    /only a Busy begin/,
  );
});

test("a cached begin is the cache source and has no ticket", () => {
  const fields = sampleFieldsFromNativeRecord(
    record({ begin: "cached", ticket: null }),
  );
  assert.equal(fields.source, "cache");
  assert.equal(fields.freshnessStamp, null);
  assert.throws(
    () => sampleFieldsFromNativeRecord(record({ begin: "cached" })),
    /no ticket/,
  );
  assert.throws(
    () =>
      sampleFieldsFromNativeRecord(
        record({ startSlot: { ...record().startSlot, kind: "warm" } }),
      ),
    /unknown start slot/,
  );
  assert.throws(
    () => sampleFieldsFromNativeRecord(record({ tBeginNs: 1.5 })),
    /tBeginNs/,
  );
});

test("the A3 record must be the read-only own connection", () => {
  const a3 = {
    schema: "nir1-graph-eval-a3/1",
    connection: "read-only-own",
    readOnly: true,
    queryOnly: true,
    tOpenStartedNs: 10,
    tSnapshotNs: 11,
    tFinishedNs: 20,
    revisions: [],
  };
  assert.deepEqual(recordReadFromA3(a3), { startedAtNs: 10, finishedAtNs: 20 });
  assert.throws(
    () => recordReadFromA3({ ...a3, queryOnly: false }),
    /\[precheck\]/,
  );
  assert.throws(
    () => recordReadFromA3({ ...a3, connection: "participant" }),
    /\[precheck\]/,
  );
  assert.throws(() => recordReadFromA3({ ...a3, tFinishedNs: 5 }), /before/);
  assert.throws(() => recordReadFromA3({ ...a3, schema: "x" }), /not an A3/);
});
