import { describe, expect, it } from "vitest";
import type {
  MaintenanceInboxConsumerKind,
  MaintenanceInboxEntry,
  MaintenanceInboxEvidenceFreshness,
} from "@/application/narrative-extraction/nativeApi";
import { summarizeInbox } from "./structureHealthModel";

function proposal(
  evidenceFreshness: MaintenanceInboxEvidenceFreshness,
): MaintenanceInboxEntry {
  return {
    entryKind: "consumer-freshness",
    consumerKind: "proposal-revision",
    evidenceFreshness,
  };
}

function other(
  consumerKind: MaintenanceInboxConsumerKind,
  evidenceFreshness: MaintenanceInboxEvidenceFreshness = "stale",
): MaintenanceInboxEntry {
  return { entryKind: "consumer-freshness", consumerKind, evidenceFreshness };
}

const FAILURE: MaintenanceInboxEntry = {
  entryKind: "terminal-failure",
  consumerKind: "narrative-maintenance-failure",
  evidenceFreshness: null,
};

describe("summarizeInbox", () => {
  it("reports nothing to inspect (not 'all well') for an empty inbox", () => {
    expect(summarizeInbox([])).toEqual({
      proposalsChecked: 0,
      proposalsStale: 0,
      staleBreakdown: {
        stale: 0,
        "source-missing": 0,
        "anchor-mismatch": 0,
        "read-set-drift": 0,
        unknown: 0,
      },
      maintenanceStopped: 0,
      unrecognized: 0,
      nothingToInspect: true,
    });
  });

  it("counts only proposal revisions as proposals and splits stale by cause", () => {
    const summary = summarizeInbox([
      proposal("fresh"),
      proposal("fresh"),
      proposal("stale"),
      proposal("stale"),
      proposal("source-missing"),
      proposal("anchor-mismatch"),
      proposal("read-set-drift"),
      proposal("unknown"),
      other("application"),
      other("narrative-extraction-run"),
      other("semantic-index"),
      other("extraction-artifact"),
    ]);
    expect(summary.proposalsChecked).toBe(8);
    expect(summary.proposalsStale).toBe(6);
    expect(summary.staleBreakdown).toEqual({
      stale: 2,
      "source-missing": 1,
      "anchor-mismatch": 1,
      "read-set-drift": 1,
      unknown: 1,
    });
    expect(summary.maintenanceStopped).toBe(0);
    expect(summary.unrecognized).toBe(0);
    expect(summary.nothingToInspect).toBe(false);
  });

  it("keeps the stale total equal to the breakdown sum", () => {
    const summary = summarizeInbox([
      proposal("stale"),
      proposal("source-missing"),
      proposal("source-missing"),
      proposal("fresh"),
    ]);
    const breakdownSum = Object.values(summary.staleBreakdown).reduce(
      (a, b) => a + b,
      0,
    );
    expect(summary.proposalsStale).toBe(breakdownSum);
    expect(summary.proposalsStale).toBe(3);
    expect(summary.proposalsChecked).toBe(4);
  });

  it("counts terminal failures on their own, never as proposals", () => {
    const summary = summarizeInbox([FAILURE, FAILURE, proposal("fresh")]);
    expect(summary.maintenanceStopped).toBe(2);
    expect(summary.proposalsChecked).toBe(1);
    expect(summary.proposalsStale).toBe(0);
    expect(summary.nothingToInspect).toBe(false);
  });

  it("keeps unrecognized values out of every known bucket", () => {
    const summary = summarizeInbox([
      proposal("unrecognized"),
      proposal(null),
      {
        entryKind: "unrecognized",
        consumerKind: "proposal-revision",
        evidenceFreshness: "stale",
      },
      proposal("stale"),
    ]);
    expect(summary.unrecognized).toBe(3);
    expect(summary.proposalsChecked).toBe(1);
    expect(summary.proposalsStale).toBe(1);
    expect(summary.staleBreakdown.unknown).toBe(0);
  });

  it("does not call a rows-but-no-proposals inbox empty when a failure exists", () => {
    expect(summarizeInbox([FAILURE]).nothingToInspect).toBe(false);
    expect(summarizeInbox([other("application")]).nothingToInspect).toBe(true);
  });

  it("counts an unknown consumer kind as unreadable instead of dropping it", () => {
    const summary = summarizeInbox([
      other("unrecognized"),
      other("unrecognized"),
    ]);
    expect(summary.unrecognized).toBe(2);
    expect(summary.proposalsChecked).toBe(0);
    expect(summary.nothingToInspect).toBe(false);
  });

  it("does not count known non-proposal kinds, so they stay 'nothing to inspect'", () => {
    const summary = summarizeInbox([
      other("narrative-extraction-run"),
      other("extraction-artifact"),
      other("application-contribution"),
      other("derived-projection"),
      other("semantic-index"),
      other("narrative-ir-revision"),
      other("related-scenes-materialization"),
      other("chat-context-materialization"),
      other("structure-health-diagnostic"),
    ]);
    expect(summary.unrecognized).toBe(0);
    expect(summary.proposalsChecked).toBe(0);
    expect(summary.nothingToInspect).toBe(true);
  });

  it("keeps known non-proposal rows out of the count while an unknown one is counted", () => {
    const summary = summarizeInbox([
      proposal("stale"),
      other("application"),
      other("unrecognized"),
    ]);
    expect(summary.proposalsChecked).toBe(1);
    expect(summary.unrecognized).toBe(1);
    expect(summary.nothingToInspect).toBe(false);
  });
});
