import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "../db/generated/schema-contract.json";
import {
  foreshadowPayoffs,
  foreshadows,
  foreshadowSetupPayoffLinks,
  foreshadowSetups,
} from "../db/schema";

describe("foreshadow multi-payoff OCC schema (SCHEMA 11)", () => {
  it("adds root OCC and setup semantic identity columns", () => {
    expect(getTableColumns(foreshadows).version.default).toBe(0);
    expect(getTableColumns(foreshadows).mechanism).toBeDefined();
    expect(getTableColumns(foreshadowSetups).role.default).toBe("unspecified");
    expect(getTableColumns(foreshadowSetups).semanticKey.default).toBe("");
  });

  it("models payoffs and setup-to-payoff links", () => {
    expect(getTableColumns(foreshadowPayoffs).foreshadowId).toBeDefined();
    expect(getTableColumns(foreshadowPayoffs).semanticKey).toBeDefined();
    expect(getTableColumns(foreshadowSetupPayoffLinks).setupId).toBeDefined();
    expect(getTableColumns(foreshadowSetupPayoffLinks).payoffId).toBeDefined();
  });

  it("is present in schema-contract at version 11+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(11);
    expect(contractJson.tables.foreshadows.columns.version).toBeDefined();
    expect(
      contractJson.tables.foreshadow_setups.columns.semantic_key,
    ).toBeDefined();
    expect(
      contractJson.tables.foreshadow_payoffs.columns.semantic_key,
    ).toBeDefined();
    expect(
      contractJson.tables.foreshadow_setup_payoff_links.columns.payoff_id,
    ).toBeDefined();
  });
});
