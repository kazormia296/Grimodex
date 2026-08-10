import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import contractJson from "./generated/schema-contract.json";
import {
  codexDetailDefinitions,
  codexDetailValues,
} from "./schema";

describe("detail OCC schema (v8)", () => {
  it("declares OCC columns on detail definitions and values", () => {
    expect(getTableName(codexDetailDefinitions)).toBe(
      "codex_detail_definitions",
    );
    expect(
      Object.values(getTableColumns(codexDetailDefinitions)).map((c) => c.name),
    ).toEqual(
      expect.arrayContaining([
        "version",
        "created_at",
        "updated_at",
      ]),
    );

    expect(getTableName(codexDetailValues)).toBe("codex_detail_values");
    expect(
      Object.values(getTableColumns(codexDetailValues)).map((c) => c.name),
    ).toEqual(
      expect.arrayContaining([
        "version",
        "created_at",
        "updated_at",
      ]),
    );
  });

  it("bumps generated schema contract to version 8 with OCC columns", () => {
    expect(contractJson.schemaVersion).toBe(8);
    const definitions = contractJson.tables.codex_detail_definitions;
    const values = contractJson.tables.codex_detail_values;
    expect(definitions).toBeDefined();
    expect(values).toBeDefined();
    expect(Object.keys(definitions.columns)).toEqual(
      expect.arrayContaining(["version", "updated_at"]),
    );
    expect(Object.keys(values.columns)).toEqual(
      expect.arrayContaining(["version", "created_at", "updated_at"]),
    );
  });
});
