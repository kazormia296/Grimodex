import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "../db/generated/schema-contract.json";
import {
  genericExtractionSchemas,
  importCaptureBlobs,
  importCaptureEntries,
  importCaptures,
  importDecodedResources,
} from "../db/schema";

describe("import capture persistence schema (SCHEMA 13)", () => {
  it("models captures, selectable entries, and digest registry", () => {
    expect(getTableColumns(importCaptures).sealedDigest).toBeDefined();
    expect(getTableColumns(importCaptures).budgetJson).toBeDefined();
    expect(getTableColumns(importCaptureEntries).captureId).toBeDefined();
    expect(getTableColumns(importCaptureEntries).captureStatus).toBeDefined();
    expect(getTableColumns(importCaptureBlobs).digest).toBeDefined();
  });

  it("models decoded resources and revisioned generic schemas", () => {
    expect(
      getTableColumns(importDecodedResources).decoderVersion,
    ).toBeDefined();
    expect(getTableColumns(genericExtractionSchemas).schemaJson).toBeDefined();
  });

  it("is present in schema-contract at version 13+", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(13);
    expect(
      contractJson.tables.import_captures.columns.budget_json,
    ).toBeDefined();
    expect(
      contractJson.tables.generic_extraction_schemas.columns.schema_json,
    ).toBeDefined();
  });
});
