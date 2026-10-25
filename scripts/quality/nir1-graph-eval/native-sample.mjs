// CP-4 S1c-1: the one place where the evaluation Native's records become the
// fields of an S1b sample (DR-CP4-S1C1-10, the S1a interface table).
//
// Two clocks never mix:
//   - renderer `performance.now()` ms: tFetch, tRawReady, tReturn,
//     graph.arrivedAt. The window (classifyJoin) reads only these.
//   - the evaluation Native clock (`Instant`, ns since the first anchor):
//     freshnessStamp.attemptedAtNs, recordRead.startedAtNs / finishedAtNs.
//     Used only for order and attribution (rule 4 overlap), never for the
//     window. There is no conversion between the two clocks.
//
// Pure module: no Electron, no Native, no file.

const DECIMAL = /^(0|[1-9][0-9]*)$/u;

/**
 * A Native evaluation-clock time (or duration) in ns. Accepts the JSON number
 * of a record or the decimal string of `nir1GraphEvalClockNs`; refuses a
 * value that is not a non-negative safe integer (a ms value converted by
 * mistake is a fraction or lost precision; an exponent form or a sign is not
 * the Native's output).
 */
export function nativeNs(value, label = "native time") {
  if (typeof value === "string") {
    if (!DECIMAL.test(value))
      throw new Error(`[artifact] ${label} is not a decimal ns string`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
      throw new Error(`[artifact] ${label} exceeds the safe integer range`);
    return parsed;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`[artifact] ${label} is not a non-negative integer ns`);
  return value;
}

export function isNativeNs(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Native ns duration → ms, for disclosure only (never a window input). */
export function nativeDurationMs(startNs, endNs) {
  const start = nativeNs(startNs, "duration start");
  const end = nativeNs(endNs, "duration end");
  if (end < start) throw new Error("[artifact] duration ends before it starts");
  return (end - start) / 1e6;
}

const SLOT_KINDS = new Set([
  "empty",
  "preparing",
  "ready",
  "in-use",
  "retiring",
  "suspended",
  "quarantined",
  "closed",
]);
const STAMP_MATCH = Object.freeze({
  fresh: true,
  stale: false,
  unavailable: null,
  "stamp0-missing": null,
});
const BEGIN_BUSY_CAUSES = new Set([
  "preparing-other-key",
  "in-use",
  "retiring",
  "edge-before-query",
  "command-queue",
  "other-key",
  "unrecorded",
]);
const TICKET_BUSY_CAUSES = new Set([
  "rebuild-window",
  "worker-capacity",
  "unrecorded",
]);

/** The Native stamp attempt → the sample's `freshnessStamp`. */
export function freshnessStampFromNative(stamp) {
  if (stamp === null || stamp === undefined) return null;
  if (!Object.hasOwn(STAMP_MATCH, stamp.result))
    throw new Error(
      `[artifact] unknown freshness stamp result ${stamp.result}`,
    );
  if (stamp.matched !== STAMP_MATCH[stamp.result])
    throw new Error(
      `[artifact] freshness stamp ${stamp.result} must carry matched=${STAMP_MATCH[stamp.result]}`,
    );
  return {
    result: stamp.result,
    matched: stamp.matched,
    attemptedAtNs: nativeNs(
      stamp.attemptedAtNs,
      "freshnessStamp.attemptedAtNs",
    ),
  };
}

/**
 * One `nir1GraphEvalSamples` record → the S1b sample fields it owns:
 * the start slot, the stamp attempt, the result's source and the Busy cause
 * (S1a table: the begin's cause when the begin answered Busy, the ticket's
 * when the ticket did). Identifiers are not in the record; the caller pairs a
 * record with its sample by order (one record per sample, the log cleared
 * before each sample).
 */
export function sampleFieldsFromNativeRecord(record) {
  const slot = record?.startSlot;
  if (!SLOT_KINDS.has(slot?.kind))
    throw new Error(`[artifact] unknown start slot ${slot?.kind}`);
  if (typeof slot.readyFresh !== "boolean")
    throw new Error("[artifact] start slot lacks readyFresh");
  const startSlot = {
    kind: slot.kind,
    readyFresh: slot.readyFresh,
    preparesReady: nativeNs(slot.preparesReady, "startSlot.preparesReady"),
    readyGeneration: nativeNs(
      slot.readyGeneration,
      "startSlot.readyGeneration",
    ),
  };
  const timing = {
    beginNs: nativeNs(record.tBeginNs, "tBeginNs"),
    returnedNs: nativeNs(record.tReturnedNs, "tReturnedNs"),
  };
  if (record.begin === "cached") {
    if (record.ticket !== null)
      throw new Error("[artifact] a cached begin carries no ticket");
    return {
      startSlot,
      freshnessStamp: null,
      source: "cache",
      busyCause: null,
      timing,
    };
  }
  if (record.begin === "unavailable") {
    if (record.ticket !== null)
      throw new Error("[artifact] an unavailable begin carries no ticket");
    let busyCause = null;
    if (record.reason === "busy") {
      if (!BEGIN_BUSY_CAUSES.has(record.busyCause))
        throw new Error(
          `[artifact] unknown begin Busy cause ${record.busyCause}`,
        );
      busyCause = record.busyCause;
    } else if (record.busyCause !== null)
      throw new Error("[artifact] only a Busy begin names a Busy cause");
    return { startSlot, freshnessStamp: null, source: null, busyCause, timing };
  }
  if (record.begin !== "pending")
    throw new Error(`[artifact] unknown begin answer ${record.begin}`);
  const ticket = record.ticket;
  if (!ticket || typeof ticket.settled !== "boolean")
    throw new Error("[artifact] a pending begin carries its ticket");
  let busyCause = null;
  if (ticket.reason === "busy") {
    if (!TICKET_BUSY_CAUSES.has(ticket.busyCause))
      throw new Error(
        `[artifact] unknown ticket Busy cause ${ticket.busyCause}`,
      );
    busyCause = ticket.busyCause;
  } else if (ticket.busyCause !== null && ticket.busyCause !== undefined)
    throw new Error("[artifact] only a Busy ticket names a Busy cause");
  return {
    startSlot,
    freshnessStamp: freshnessStampFromNative(ticket.freshnessStamp),
    source: ticket.outcome === "available" ? "worker" : null,
    busyCause,
    ticket: {
      settled: ticket.settled,
      outcome: ticket.outcome ?? null,
      reason: ticket.reason ?? null,
      disposition: ticket.disposition ?? null,
      ticketNs: nativeNs(ticket.tTicketNs, "ticket.tTicketNs"),
      settledNs:
        ticket.tSettledNs === null || ticket.tSettledNs === undefined
          ? null
          : nativeNs(ticket.tSettledNs, "ticket.tSettledNs"),
    },
    timing,
  };
}

/**
 * The A3 record (`nir1GraphEvalReadA3`) → the sample's `recordRead`. The
 * record must come from the read-only own connection (K6/2 Mandatory
 * defenses); anything else stops with `[precheck]`.
 */
export function recordReadFromA3(record) {
  if (record?.schema !== "nir1-graph-eval-a3/1")
    throw new Error("[artifact] not an A3 record");
  if (
    record.connection !== "read-only-own" ||
    record.readOnly !== true ||
    record.queryOnly !== true
  )
    throw new Error(
      "[precheck] the A3 record did not use the read-only own connection",
    );
  const startedAtNs = nativeNs(record.tOpenStartedNs, "A3 tOpenStartedNs");
  const finishedAtNs = nativeNs(record.tFinishedNs, "A3 tFinishedNs");
  if (finishedAtNs < startedAtNs)
    throw new Error("[artifact] A3 record finishes before it starts");
  return { startedAtNs, finishedAtNs };
}
