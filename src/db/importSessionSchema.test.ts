import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "../db/generated/schema-contract.json";
import {
  importCommits,
  importEvidenceBindings,
  importSessions,
  importSourceBaselines,
  importSourceMappings,
  importSourcePackages,
} from "../db/schema";

describe("import session persistence schema (SCHEMA 12)", () => {
  it("models resumable import sessions and source packages", () => {
    expect(getTableColumns(importSessions).targetJson).toBeDefined();
    expect(getTableColumns(importSessions).extractionRunIdsJson.default).toBe(
      "[]",
    );
    expect(getTableColumns(importSessions).proposalSetIdsJson.default).toBe(
      "[]",
    );
    expect(getTableColumns(importSourcePackages).sessionId).toBeDefined();
    expect(getTableColumns(importSourcePackages).digest).toBeDefined();
  });

  it("models source mappings, baselines, commits, and evidence bindings", () => {
    expect(getTableColumns(importSourceMappings).sourceObjectKey).toBeDefined();
    expect(getTableColumns(importSourceBaselines).mappingId).toBeDefined();
    expect(getTableColumns(importCommits).requestId).toBeDefined();
    expect(
      getTableColumns(importEvidenceBindings).committedStorageDigest,
    ).toBeDefined();
  });

  it("is present in schema-contract at version 12+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(12);
    expect(
      contractJson.tables.import_sessions.columns.target_json,
    ).toBeDefined();
    expect(
      contractJson.tables.import_source_packages.columns.package_json,
    ).toBeDefined();
    expect(contractJson.tables.import_commits.columns.request_id).toBeDefined();
  });
});
