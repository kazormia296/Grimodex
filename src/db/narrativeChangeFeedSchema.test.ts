import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import {
  narrativeChangeCursors,
  narrativeChangeEvents,
  narrativeChangeObjectHeads,
  narrativeChangeSets,
  narrativeChangeTransactions,
} from "./schema";

describe("narrative maintenance Change Feed schema (SCHEMA 22)", () => {
  it("models project-scoped canonical correlation and mutation semantics", () => {
    const transactions = getTableColumns(narrativeChangeTransactions);
    const events = getTableColumns(narrativeChangeEvents);
    expect(transactions.projectId).toBeDefined();
    expect(transactions.requestId).toBeDefined();
    expect(transactions.sourceChangeEventUid).toBeDefined();
    expect(transactions.sourceChangeEventSequence).toBeDefined();
    expect(transactions.causeKind).toBeDefined();
    expect(transactions.origin).toBeDefined();
    expect(transactions.undoJournalId).toBeDefined();
    expect(events.canonicalChangeEventUid).toBeDefined();
    expect(events.canonicalSequence).toBeDefined();
    expect(events.eventOrdinal).toBeDefined();
    expect(events.mutationKind).toBeDefined();
    const heads = getTableColumns(narrativeChangeObjectHeads);
    expect(heads.objectIdentity).toBeDefined();
    expect(heads.afterDigest).toBeDefined();
    expect(heads.eventId).toBeDefined();
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

  it("is emitted by the SCHEMA 22 Native migration contract", () => {
    // SCHEMA 23 added reservation columns to narrative_change_cursors. SCHEMA 41
    // removes stale project epoch-marker heads without changing the
    // narrative_change_* table/index definitions. Keep this exact guard so
    // each schema bump revisits the contract assertions below.
    expect(contractJson.schemaVersion).toBe(41);
    expect(
      contractJson.tables.narrative_change_transactions.columns
        .source_change_event_uid,
    ).toBeDefined();
    expect(
      contractJson.tables.narrative_change_transactions.columns.origin,
    ).toMatchObject({
      declaredType: "TEXT",
      notNull: true,
      default: null,
    });
    expect(
      contractJson.tables.narrative_change_transactions.columns.undo_journal_id,
    ).toMatchObject({
      declaredType: "TEXT",
      notNull: false,
      default: null,
    });
    expect(
      contractJson.tables.narrative_change_transactions.createSql,
    ).toContain(
      "CHECK(origin IN ('human','ai-apply','import','undo','redo','restore','migration'))",
    );
    expect(
      contractJson.tables.narrative_change_events.columns.mutation_kind,
    ).toBeDefined();
    expect(contractJson.tables.narrative_change_cursors).toBeDefined();
    expect(contractJson.tables.narrative_change_sets).toBeDefined();
    expect(contractJson.tables.narrative_change_object_heads).toBeDefined();
    expect(
      contractJson.indexes.idx_narrative_change_object_heads_project_sequence,
    ).toBeDefined();
  });
});
