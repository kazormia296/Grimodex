import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import {
  narrativeTemporalConstraints,
  narrativeTemporalNodes,
  narrativeTemporalProjections,
} from "./schema";

describe("narrative temporal tables schema", () => {
  it("exposes nodes / constraints / projections with version columns", () => {
    expect(getTableColumns(narrativeTemporalNodes).version.default).toBe(0);
    expect(getTableColumns(narrativeTemporalConstraints).version.default).toBe(
      0,
    );
    expect(getTableColumns(narrativeTemporalProjections).version.default).toBe(
      0,
    );
  });

  it("is present in schema-contract at SCHEMA_VERSION 9+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(9);
    expect(contractJson.tables.narrative_temporal_nodes).toBeDefined();
    expect(contractJson.tables.narrative_temporal_constraints).toBeDefined();
    expect(contractJson.tables.narrative_temporal_projections).toBeDefined();
  });
});
