/**
 * Main-side delivery/fence ledger for the common lifecycle contract.
 *
 * Delivery receipts and recovery responsibility have different lifetimes.
 * A terminal receipt may retire after the main driver ACKs it while the
 * descriptor for the unfinished Run remains live.  The ledger therefore
 * keeps a bounded normal queue (256 records) and one control cell per active
 * recovery root; recovery never asks the normal queue for another record.
 */

export type DeliveryAdmission =
  | "admitted"
  | "not-admitted"
  | "duplicate"
  | "out-of-order"
  | "sealed-absent";

export type DeliveryRecordState = "pending" | "terminal";

export interface DeliveryRecord {
  readonly sequence: number;
  readonly fingerprint: string;
  readonly state: DeliveryRecordState;
  readonly rootId: string | null;
  readonly acked: boolean;
}

export interface RecoveryDescriptor {
  readonly rootId: string;
  readonly generation: number;
  readonly phase: "run-pending" | "run-resolved" | "activation-required";
  readonly resultAcked: boolean;
}

export interface SubmitResult {
  readonly admission: DeliveryAdmission;
  readonly sequence: number;
  readonly record?: DeliveryRecord;
}

export interface RecoveryResult {
  readonly admission:
    | "recovered"
    | "not-admitted"
    | "payload-conflict"
    | "retired";
  readonly descriptor?: RecoveryDescriptor;
}

// Delivery records have the full 256-cell transport budget. The separate
// shared-core responsibility ledger reserves 255 ordinary responsibility
// cells plus one recovery-transition cell; those budgets must not be merged.
const NORMAL_CAPACITY = 256;

function cloneRecord(record: DeliveryRecord): DeliveryRecord {
  return { ...record };
}

function cloneDescriptor(descriptor: RecoveryDescriptor): RecoveryDescriptor {
  return { ...descriptor };
}

/**
 * Deterministic ledger used by the main driver and by Layer-A tests.  It does
 * not perform I/O or schedule workers; native admission remains the trusted
 * owner.  The API makes the capacity/fence invariants explicit at the point
 * where a new sequence is admitted.
 */
export class NarrativeMaintenanceDeliveryLedger {
  private highWaterMark = 0;
  private readonly records = new Map<number, DeliveryRecord>();
  private readonly descriptors = new Map<string, RecoveryDescriptor>();
  private readonly recoveryRequests = new Map<
    string,
    { fingerprint: string; generation: number }
  >();
  // Native descriptor roots are decimal, session-monotonic IDs. Keep retired
  // roots as coalesced numeric ranges so a long-lived session cannot grow a
  // string tombstone set in proportion to every completed recovery. Gaps are
  // retained for unresolved roots and therefore bound the range count.
  private readonly retiredRootRanges = new Map<number, number>();

  get H(): number {
    return this.highWaterMark;
  }

  submit(
    sequence: number,
    fingerprint: string,
    rootId: string | null = null,
  ): SubmitResult {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      !fingerprint.trim()
    ) {
      throw new Error("delivery sequence and fingerprint are required");
    }
    const existing = this.records.get(sequence);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return { admission: "not-admitted", sequence };
      }
      return {
        admission: "duplicate",
        sequence,
        record: cloneRecord(existing),
      };
    }
    // ACK retires the record but never rewinds the sealed high-water mark.
    // A late callback for an older sequence therefore resolves to the same
    // absent/retired outcome instead of being mistaken for a new admission.
    if (sequence <= this.highWaterMark) {
      return { admission: "sealed-absent", sequence };
    }
    if (sequence !== this.highWaterMark + 1) {
      return { admission: "out-of-order", sequence };
    }
    if (this.records.size >= NORMAL_CAPACITY) {
      // Capacity is a temporary admission condition.  Do not consume H+1 or
      // seal it here: the scheduler does not send a Native fence for this
      // local rejection, and the exact request must be retriable after an ACK
      // retires one ordinary record.  A capacity rejection therefore has no
      // transport side effect at all.
      return { admission: "not-admitted", sequence };
    }
    const record: DeliveryRecord = {
      sequence,
      fingerprint,
      state: "pending",
      rootId,
      acked: false,
    };
    this.records.set(sequence, record);
    this.highWaterMark = sequence;
    return { admission: "admitted", sequence, record: cloneRecord(record) };
  }

  /** Seal an unknown next sequence without allocating a delivery record. */
  resolveOrFence(sequence: number): SubmitResult {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error("delivery sequence is required");
    }
    if (sequence <= this.highWaterMark) {
      const record = this.records.get(sequence);
      return record
        ? { admission: "duplicate", sequence, record: cloneRecord(record) }
        : { admission: "sealed-absent", sequence };
    }
    if (sequence !== this.highWaterMark + 1) {
      return { admission: "out-of-order", sequence };
    }
    this.highWaterMark = sequence;
    return { admission: "sealed-absent", sequence };
  }

  markTerminal(sequence: number): DeliveryRecord {
    const record = this.records.get(sequence);
    if (!record) throw new Error("cannot terminalize an unknown delivery");
    const terminal = { ...record, state: "terminal" as const };
    this.records.set(sequence, terminal);
    return cloneRecord(terminal);
  }

  /** ACK retires only the delivery record.  A descriptor is independent. */
  ack(sequence: number): boolean {
    const record = this.records.get(sequence);
    if (!record || record.state !== "terminal") return false;
    this.records.delete(sequence);
    return true;
  }

  /** Retire a sequence that Native explicitly fenced without a record. */
  retireFenced(sequence: number): boolean {
    return this.records.delete(sequence);
  }

  reserveRecovery(rootId: string): RecoveryDescriptor {
    const ordinal = this.parseRootOrdinal(rootId);
    if (this.isRetiredRoot(ordinal)) {
      throw new Error("recovery root is retired");
    }
    const existing = this.descriptors.get(rootId);
    if (existing) return cloneDescriptor(existing);
    const descriptor: RecoveryDescriptor = {
      rootId,
      generation: 1,
      phase: "run-pending",
      resultAcked: false,
    };
    this.descriptors.set(rootId, descriptor);
    return cloneDescriptor(descriptor);
  }

  recover(rootId: string, fingerprint: string): RecoveryResult {
    const descriptor = this.descriptors.get(rootId);
    const ordinal = this.parseRootOrdinal(rootId);
    if (!descriptor || this.isRetiredRoot(ordinal)) {
      return { admission: "retired" };
    }
    if (!fingerprint.trim()) {
      throw new Error("recovery fingerprint is required");
    }
    const previous = this.recoveryRequests.get(rootId);
    if (
      previous &&
      previous.fingerprint !== fingerprint &&
      !descriptor.resultAcked
    ) {
      return {
        admission: "payload-conflict",
        descriptor: cloneDescriptor(descriptor),
      };
    }
    if (previous?.fingerprint === fingerprint && !descriptor.resultAcked) {
      // A lost response is replayed from the same control generation.  Do not
      // create another Run recovery attempt merely because the caller retried
      // before the current control result was acknowledged.
      return {
        admission: "recovered",
        descriptor: cloneDescriptor(descriptor),
      };
    }
    // The descriptor's generation is the idempotency boundary.  Recovery is
    // deliberately independent from normal delivery capacity. A new request
    // is legal only after the prior control result was ACKed.
    const next: RecoveryDescriptor = {
      ...descriptor,
      generation: descriptor.generation + 1,
      phase: "run-resolved",
      resultAcked: false,
    };
    this.descriptors.set(rootId, next);
    this.recoveryRequests.set(rootId, {
      fingerprint,
      generation: next.generation,
    });
    return { admission: "recovered", descriptor: cloneDescriptor(next) };
  }

  markActivationRequired(rootId: string): RecoveryDescriptor {
    const descriptor = this.descriptors.get(rootId);
    if (!descriptor) throw new Error("unknown recovery root");
    const next = { ...descriptor, phase: "activation-required" as const };
    this.descriptors.set(rootId, next);
    return cloneDescriptor(next);
  }

  ackRecovery(rootId: string): boolean {
    const descriptor = this.descriptors.get(rootId);
    if (!descriptor) return false;
    this.descriptors.set(rootId, { ...descriptor, resultAcked: true });
    return true;
  }

  retireRecovery(rootId: string): boolean {
    const ordinal = this.parseRootOrdinal(rootId);
    const descriptor = this.descriptors.get(rootId);
    if (!descriptor || !descriptor.resultAcked) return false;
    this.descriptors.delete(rootId);
    this.recoveryRequests.delete(rootId);
    this.markRetiredRoot(ordinal);
    return true;
  }

  private parseRootOrdinal(rootId: string): number {
    if (!/^\d+$/.test(rootId)) {
      throw new Error("recovery root must be a monotonic decimal descriptor id");
    }
    const ordinal = Number(rootId);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
      throw new Error("recovery root must be a positive safe descriptor id");
    }
    return ordinal;
  }

  private isRetiredRoot(ordinal: number): boolean {
    return [...this.retiredRootRanges.entries()]
      .reverse()
      .some(([start, end]) => start <= ordinal && end >= ordinal);
  }

  private markRetiredRoot(ordinal: number): void {
    let start = ordinal;
    let end = ordinal;
    const ranges = [...this.retiredRootRanges.entries()].sort(
      ([left], [right]) => left - right,
    );
    for (const [rangeStart, rangeEnd] of ranges) {
      if (rangeEnd + 1 < start || rangeStart > end + 1) continue;
      start = Math.min(start, rangeStart);
      end = Math.max(end, rangeEnd);
      this.retiredRootRanges.delete(rangeStart);
    }
    this.retiredRootRanges.set(start, end);
  }

  recordsSnapshot(): readonly DeliveryRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  descriptorsSnapshot(): readonly RecoveryDescriptor[] {
    return [...this.descriptors.values()].map(cloneDescriptor);
  }
}
