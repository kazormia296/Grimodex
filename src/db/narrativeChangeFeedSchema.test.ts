import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import {
  narrativeChangeCursors,
  narrativeChangeEvents,
  narrativeChangeSets,
  narrativeChangeTransactions,
} from "./schema";

describe("narrative maintenance Change Feed schema (SCHEMA 21)", () => {
  it("models project-scoped canonical correlation and mutation semantics", () => {
    const transactions = getTableColumns(narrativeChangeTransactions);
    const events = getTableColumns(narrativeChangeEvents);
    expect(transactions.projectId).toBeDefined();
    expect(transactions.requestId).toBeDefined();
    expect(transactions.sourceChangeEventUid).toBeDefined();
    expect(transactions.sourceChangeEventSequence).toBeDefined();
    expect(transactions.causeKind).toBeDefined();
    expect(events.canonicalChangeEventUid).toBeDefined();
    expect(events.canonicalSequence).toBeDefined();
    expect(events.eventOrdinal).toBeDefined();
    expect(events.mutationKind).toBeDefined();
  });

  it("models project-scoped cursors and deterministic coalesced sets", () => {
    expect(getTableColumns(narrativeChangeCursors).projectId).toBeDefined();
    expect(
      getTableColumns(narrativeChangeCursors).acknowledgedThroughSequence,
    ).toBeDefined();
    expect(getTableColumns(narrativeChangeSets).projectId).toBeDefined();
    expect(
      getTableColumns(narrativeChangeSets).throughSequenceInclusive,
    ).toBeDefined();
  });

  it("is emitted by the SCHEMA 21 Native migration contract", () => {
    expect(contractJson.schemaVersion).toBe(21);
    expect(
      contractJson.tables.narrative_change_transactions.columns
        .source_change_event_uid,
    ).toBeDefined();
    expect(
      contractJson.tables.narrative_change_events.columns.mutation_kind,
    ).toBeDefined();
    expect(contractJson.tables.narrative_change_cursors).toBeDefined();
    expect(contractJson.tables.narrative_change_sets).toBeDefined();
  });
});
