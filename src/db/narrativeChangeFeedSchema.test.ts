import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "../db/generated/schema-contract.json";
import {
  narrativeApplicationContributions,
  narrativeChangeCursors,
  narrativeChangeEvents,
  narrativeChangeTransactions,
  narrativeDependencyEdges,
  narrativeFreshnessRecords,
} from "../db/schema";

describe("narrative maintenance change feed schema (SCHEMA 14)", () => {
  it("models transactional change feed + cursors", () => {
    expect(getTableColumns(narrativeChangeTransactions).projectSequence).toBeDefined();
    expect(getTableColumns(narrativeChangeEvents).eventOrdinal).toBeDefined();
    expect(getTableColumns(narrativeChangeCursors).acknowledgedThroughSequence).toBeDefined();
  });

  it("models dependency and freshness surfaces", () => {
    expect(getTableColumns(narrativeDependencyEdges).invalidationPolicy).toBeDefined();
    expect(getTableColumns(narrativeFreshnessRecords).freshness).toBeDefined();
    expect(getTableColumns(narrativeApplicationContributions).baselineSequence).toBeDefined();
  });

  it("is present in schema-contract at version 14+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(14);
    expect(
      contractJson.tables.narrative_change_transactions.columns.project_sequence,
    ).toBeDefined();
    expect(
      contractJson.tables.narrative_change_events.columns.event_ordinal,
    ).toBeDefined();
  });
});
