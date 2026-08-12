import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "../db/generated/schema-contract.json";
import {
  plotThreadBranches,
  plotThreads,
  plotThreadSceneLinks,
} from "../db/schema";

describe("plot thread OCC schema (SCHEMA 10)", () => {
  it("adds version to threads / markers / branches", () => {
    expect(getTableColumns(plotThreads).version.default).toBe(0);
    expect(getTableColumns(plotThreadSceneLinks).version.default).toBe(0);
    expect(getTableColumns(plotThreadBranches).version.default).toBe(0);
  });

  it("adds semantic_key to markers and branches", () => {
    expect(getTableColumns(plotThreadSceneLinks).semanticKey).toBeDefined();
    expect(getTableColumns(plotThreadBranches).semanticKey).toBeDefined();
  });

  it("is present in schema-contract at version 10+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(10);
    expect(
      contractJson.tables.plot_threads.columns.version,
    ).toBeDefined();
    expect(
      contractJson.tables.plot_thread_scene_links.columns.semantic_key,
    ).toBeDefined();
    expect(
      contractJson.tables.plot_thread_branches.columns.semantic_key,
    ).toBeDefined();
  });
});
