import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, expectTypeOf, it } from "vitest";

import contractJson from "./generated/schema-contract.json";
import * as schema from "./schema";

const TABLE_NAME = "codex_detail_semantic_bindings";
const EXPECTED_COLUMNS = [
  "id",
  "project_id",
  "definition_id",
  "facet_key",
  "projection_kind",
  "temporal_policy",
  "source",
  "confirmed",
  "version",
  "created_at",
  "updated_at",
] as const;

type ContractTable = {
  columns: Record<string, unknown>;
  foreignKeys: Array<{
    id: number;
    sequence: number;
    table: string;
    from: string;
    to: string;
    onDelete: string;
  }>;
  uniqueConstraints: Array<{ columns: string[] }>;
};

type SchemaContract = {
  schemaVersion: number;
  tables: Record<string, ContractTable>;
  indexes: Record<
    string,
    {
      table: string;
      unique: boolean;
      columns: Array<{ column: string | null }>;
    }
  >;
};

function semanticBindingTable(): SQLiteTable | undefined {
  return (schema as unknown as Record<string, SQLiteTable | undefined>)
    .codexDetailSemanticBindings;
}

function hasOrderedColumns(
  actual: readonly (string | null)[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((column, index) => column === expected[index])
  );
}

describe("codexDetailSemanticBindings Drizzle schema", () => {
  it("maps the persisted confirmed integer to the domain boolean", () => {
    type Binding = typeof schema.codexDetailSemanticBindings.$inferSelect;
    expectTypeOf<Binding["confirmed"]>().toEqualTypeOf<boolean>();
  });

  it("declares the canonical semantic binding table and columns", () => {
    const table = semanticBindingTable();
    expect(
      table,
      "schema.ts must export codexDetailSemanticBindings",
    ).toBeDefined();
    if (!table) return;

    expect(getTableName(table)).toBe(TABLE_NAME);
    expect(
      Object.values(getTableColumns(table)).map((column) => column.name),
    ).toEqual(EXPECTED_COLUMNS);
  });

  it("binds definition_id to a definition in the same Project", () => {
    const table = semanticBindingTable();
    expect(table).toBeDefined();
    if (!table) return;

    const compositeDefinitionForeignKey = getTableConfig(
      table,
    ).foreignKeys.find((foreignKey) => {
      const reference = foreignKey.reference();
      return (
        getTableName(reference.foreignTable) === "codex_detail_definitions" &&
        hasOrderedColumns(
          reference.columns.map((column) => column.name),
          ["project_id", "definition_id"],
        ) &&
        hasOrderedColumns(
          reference.foreignColumns.map((column) => column.name),
          ["project_id", "id"],
        )
      );
    });

    expect(
      compositeDefinitionForeignKey,
      "project_id and definition_id must use one composite FK",
    ).toBeDefined();
    expect(compositeDefinitionForeignKey?.onDelete).toBe("cascade");
  });

  it("prevents duplicate facets for one definition and indexes Project facet lookup", () => {
    const table = semanticBindingTable();
    expect(table).toBeDefined();
    if (!table) return;

    const indexes = getTableConfig(table).indexes;
    expect(
      indexes.some(
        (index) =>
          index.config.unique &&
          hasOrderedColumns(
            index.config.columns.map((column) =>
              "name" in column ? column.name : null,
            ),
            ["definition_id", "facet_key"],
          ),
      ),
    ).toBe(true);
    expect(
      indexes.some(
        (index) =>
          !index.config.unique &&
          hasOrderedColumns(
            index.config.columns.map((column) =>
              "name" in column ? column.name : null,
            ),
            ["project_id", "facet_key"],
          ),
      ),
    ).toBe(true);
  });
});

describe("generated semantic binding schema contract", () => {
  const contract = contractJson as unknown as SchemaContract;

  it("retains the semantic binding checkpoint introduced in v4", () => {
    expect(contract.schemaVersion).toBeGreaterThanOrEqual(4);
  });

  it("contains the semantic binding table and exact persisted columns", () => {
    const table = contract.tables[TABLE_NAME];
    expect(
      table,
      "generate schema-contract.json after the Rust migration is added",
    ).toBeDefined();
    if (!table) return;

    expect(Object.keys(table.columns)).toEqual(
      expect.arrayContaining([...EXPECTED_COLUMNS]),
    );
    expect(Object.keys(table.columns)).toHaveLength(EXPECTED_COLUMNS.length);
  });

  it("records same-Project definition ownership and required indexes", () => {
    const table = contract.tables[TABLE_NAME];
    expect(table).toBeDefined();
    if (!table) return;

    const groupedForeignKeys = new Map<number, typeof table.foreignKeys>();
    for (const foreignKey of table.foreignKeys) {
      const group = groupedForeignKeys.get(foreignKey.id) ?? [];
      group.push(foreignKey);
      groupedForeignKeys.set(foreignKey.id, group);
    }
    expect(
      [...groupedForeignKeys.values()].some(
        (foreignKeys) =>
          foreignKeys.every(
            (foreignKey) =>
              foreignKey.table === "codex_detail_definitions" &&
              foreignKey.onDelete === "CASCADE",
          ) &&
          hasOrderedColumns(
            [...foreignKeys]
              .sort((left, right) => left.sequence - right.sequence)
              .map((foreignKey) => foreignKey.from),
            ["project_id", "definition_id"],
          ) &&
          hasOrderedColumns(
            [...foreignKeys]
              .sort((left, right) => left.sequence - right.sequence)
              .map((foreignKey) => foreignKey.to),
            ["project_id", "id"],
          ),
      ),
    ).toBe(true);

    const tableIndexes = Object.values(contract.indexes).filter(
      (index) => index.table === TABLE_NAME,
    );
    const physicalUnique = [
      ...table.uniqueConstraints.map((constraint) => ({
        unique: true,
        columns: constraint.columns,
      })),
      ...tableIndexes.map((index) => ({
        unique: index.unique,
        columns: index.columns.map((column) => column.column),
      })),
    ];
    expect(
      physicalUnique.some(
        (index) =>
          index.unique &&
          hasOrderedColumns(index.columns, ["definition_id", "facet_key"]),
      ),
    ).toBe(true);
    expect(
      tableIndexes.some(
        (index) =>
          !index.unique &&
          hasOrderedColumns(
            index.columns.map((column) => column.column),
            ["project_id", "facet_key"],
          ),
      ),
    ).toBe(true);
  });
});
