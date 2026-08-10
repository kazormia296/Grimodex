import { describe, expect, it } from "vitest";
import { validateGenericExtractionSchema } from "./schemaValidation";
import type { GenericExtractionSchema } from "./schemaTypes";

describe("schemaValidation", () => {
  it("accepts a valid shallow schema", () => {
    const schema: GenericExtractionSchema = {
      schemaId: "test",
      version: 1,
      label: "Test",
      records: [
        {
          recordId: "character",
          label: "Character",
          fields: [
            { fieldId: "name", label: "Name", type: "string", required: true },
            { fieldId: "role", label: "Role", type: "enum", enumValues: ["hero", "villain"] },
          ],
        },
      ],
    };
    expect(validateGenericExtractionSchema(schema).ok).toBe(true);
  });

  it("rejects unknown field types", () => {
    const schema = {
      schemaId: "bad",
      version: 1,
      label: "Bad",
      records: [
        {
          recordId: "r1",
          label: "R1",
          fields: [{ fieldId: "x", label: "X", type: "object" }],
        },
      ],
    } as unknown as GenericExtractionSchema;
    const result = validateGenericExtractionSchema(schema);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "schema-unknown-field-type")).toBe(
      true,
    );
  });

  it("rejects recursive nested records", () => {
    const characterRecord = {
      recordId: "character",
      label: "Character",
      fields: [{ fieldId: "name", label: "Name", type: "string" as const }],
      nestedRecords: [] as GenericExtractionSchema["records"],
    };
    characterRecord.nestedRecords = [characterRecord];
    const schema: GenericExtractionSchema = {
      schemaId: "recursive",
      version: 1,
      label: "Recursive",
      records: [characterRecord],
    };
    const result = validateGenericExtractionSchema(schema);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "schema-recursive-record")).toBe(
      true,
    );
  });

  it("rejects schemas exceeding record limit", () => {
    const records = Array.from({ length: 17 }, (_, index) => ({
      recordId: `r${index}`,
      label: `R${index}`,
      fields: [{ fieldId: "a", label: "A", type: "string" as const }],
    }));
    const result = validateGenericExtractionSchema({
      schemaId: "many",
      version: 1,
      label: "Many",
      records,
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "schema-too-many-records")).toBe(
      true,
    );
  });
});
