import { describe, expect, it } from "vitest";
import { NarrativeMaintenanceDeliveryLedger } from "./narrativeMaintenanceDelivery.js";

describe("NarrativeMaintenanceDeliveryLedger", () => {
  it("fences the next sequence without consuming a delivery cell", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    expect(ledger.resolveOrFence(1).admission).toBe("sealed-absent");
    expect(ledger.submit(1, "late").admission).toBe("sealed-absent");
    expect(ledger.submit(2, "next").admission).toBe("admitted");
  });

  it("keeps recovery progress available when normal delivery is full", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    for (let sequence = 1; sequence <= 256; sequence += 1) {
      expect(ledger.submit(sequence, `fp-${sequence}`).admission).toBe(
        "admitted",
      );
    }
    expect(ledger.submit(257, "full").admission).toBe("not-admitted");
    const descriptor = ledger.reserveRecovery("1");
    expect(ledger.recover("1", "run-proof").admission).toBe("recovered");
    expect(ledger.descriptorsSnapshot()[0]?.generation).toBe(
      descriptor.generation + 1,
    );
    expect(ledger.submit(257, "after-recovery").admission).toBe("not-admitted");
    expect(ledger.markTerminal(1).state).toBe("terminal");
    expect(ledger.ack(1)).toBe(true);
    expect(ledger.submit(257, "after-ack").admission).toBe("admitted");
    ledger.markTerminal(257);
    expect(ledger.ack(257)).toBe(true);
    expect(ledger.submit(258, "after-ack-next").admission).toBe("admitted");
  });

  it("does not consume H+1 when local capacity rejects a delivery", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    for (let sequence = 1; sequence <= 256; sequence += 1) {
      expect(ledger.submit(sequence, `fp-${sequence}`).admission).toBe(
        "admitted",
      );
    }
    expect(ledger.H).toBe(256);
    expect(ledger.submit(257, "full").admission).toBe("not-admitted");
    expect(ledger.H).toBe(256);
    ledger.markTerminal(1);
    expect(ledger.ack(1)).toBe(true);
    expect(ledger.submit(257, "after-capacity").admission).toBe("admitted");
  });

  it("retires delivery records independently of unresolved descriptors", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    ledger.submit(1, "fp", "root-w1");
    ledger.markTerminal(1);
    ledger.reserveRecovery("1");
    expect(ledger.ack(1)).toBe(true);
    expect(ledger.descriptorsSnapshot()).toHaveLength(1);
    expect(ledger.retireRecovery("1")).toBe(false);
    ledger.ackRecovery("1");
    expect(ledger.retireRecovery("1")).toBe(true);
    expect(ledger.recover("1", "late").admission).toBe("retired");
  });

  it("gives each recovery root its own control slot", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    ledger.reserveRecovery("1");
    ledger.reserveRecovery("2");
    expect(ledger.recover("1", "proof-w1").admission).toBe("recovered");
    expect(ledger.recover("2", "proof-w2").admission).toBe("recovered");
    expect(ledger.descriptorsSnapshot()).toHaveLength(2);
  });

  it("does not replay an acknowledged recovery generation", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    ledger.reserveRecovery("1");
    const first = ledger.recover("1", "proof-w1");
    expect(first.descriptor?.generation).toBe(2);
    expect(ledger.ackRecovery("1")).toBe(true);
    const next = ledger.recover("1", "proof-w1");
    expect(next.admission).toBe("recovered");
    expect(next.descriptor?.generation).toBe(3);
    expect(next.descriptor?.resultAcked).toBe(false);
  });

  it("does not reuse an ACK-retired sequence", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    expect(ledger.submit(1, "first").admission).toBe("admitted");
    ledger.markTerminal(1);
    expect(ledger.ack(1)).toBe(true);
    expect(ledger.submit(1, "late").admission).toBe("sealed-absent");
  });

  it("keeps recovery roots retired for the whole session", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    for (let index = 1; index <= 257; index += 1) {
      const root = String(index);
      ledger.reserveRecovery(root);
      ledger.ackRecovery(root);
      expect(ledger.retireRecovery(root)).toBe(true);
    }
    expect(() => ledger.reserveRecovery("1")).toThrow();
    expect(ledger.recover("1", "late").admission).toBe("retired");
  });

  it("retires a locally admitted sequence after Native fences it without a record", () => {
    const ledger = new NarrativeMaintenanceDeliveryLedger();
    expect(ledger.submit(1, "pre-admission-rejection").admission).toBe("admitted");
    expect(ledger.retireFenced(1)).toBe(true);
    expect(ledger.recordsSnapshot()).toHaveLength(0);
    expect(ledger.submit(2, "next").admission).toBe("admitted");
  });
});
