import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import {
  getTableConfig,
  type SQLiteColumn,
  type SQLiteTable,
} from "drizzle-orm/sqlite-core";
import { createBrowserMock } from "@/lib/browser-mock";
import * as schema from "./schema";
import contract from "./generated/schema-contract.json";

type SchemaContract = {
  tables: Record<
    string,
    {
      columns: Record<
        string,
        {
          declaredType: string;
          notNull: boolean;
          default: string | null;
          primaryKey: number;
        }
      >;
      foreignKeys: {
        table: string;
        from: string;
        to: string | null;
        onDelete: string;
        onUpdate: string;
      }[];
      uniqueConstraints: { columns: string[] }[];
    }
  >;
  indexes: Record<
    string,
    {
      table: string;
      unique: boolean;
      partial: boolean;
      columns: { column: string | null }[];
    }
  >;
};

const RUST_ONLY_TABLES = new Set([
  "chat_message_chunks",
  "event_chunks",
  "fts_meta",
  "codex_fts",
  "codex_fts_en",
  "snippets_fts",
  "snippets_fts_en",
  "chat_messages_fts",
  "chat_messages_fts_en",
  "tree_nodes_fts",
  "tree_nodes_fts_en",
  "post_effect_annotations_fts",
  "post_effect_annotations_fts_en",
  "undo_journal",
]);

const RUST_ONLY_COLUMNS: Record<string, Set<string>> = {
  projects: new Set(["is_sample"]),
};

const BROWSER_SCHEMA_TABLES = [
  "app_settings",
  "authorship_spans",
  "change_events",
  "chat_messages",
  "chat_session_pinned_codex",
  "chat_sessions",
  "chat_summaries",
  "chat_summary_messages",
  "codex_detail_definitions",
  "codex_detail_values",
  "codex_dismissed_relations",
  "codex_entries",
  "codex_entry_tags",
  "codex_quick_pins",
  "codex_relations",
  "codex_tags",
  "codex_types",
  "content_versions",
  "event_participants",
  "event_relations",
  "events",
  "foreshadow_setups",
  "foreshadows",
  "generation_logs",
  "labels",
  "lint_term_dictionary",
  "map_ai_branches",
  "map_boards",
  "map_edges",
  "map_frames",
  "map_node_positions",
  "map_stickies",
  "plot_thread_branches",
  "plot_thread_scene_links",
  "plot_threads",
  "project_calendar",
  "project_settings",
  "project_snapshot_aux",
  "project_snapshot_codex_entries",
  "project_snapshot_entries",
  "project_snapshot_snippets",
  "project_snapshot_tree_nodes",
  "project_snapshots",
  "projects",
  "scene_beat_pov_cache",
  "scene_codex_mentions",
  "scene_events",
  "snippets",
  "tree_node_labels",
  "tree_nodes",
].sort();

function collectDrizzleTables(): Record<string, SQLiteTable> {
  const tables: Record<string, SQLiteTable> = {};
  for (const value of Object.values(schema) as unknown[]) {
    if (!value || typeof value !== "object") continue;
    try {
      const table = value as SQLiteTable;
      const config = getTableConfig(table);
      if (config.name && config.columns.length > 0) {
        tables[config.name] = table;
      }
    } catch {
      // schema.ts also exports enum arrays and type-only helpers.
    }
  }
  return tables;
}

function normalizeType(value: string): string {
  return value.split(/\s+/).join(" ").toUpperCase();
}

function normalizeDefault(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return String(Number(trimmed));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function normalizeForeignKeyAction(value: string | undefined): string {
  return (value ?? "no action").toUpperCase();
}

function queryRows(result: unknown): Record<string, unknown>[] {
  if (!result || typeof result !== "object" || !("rows" in result)) {
    throw new Error("browser mock query did not return rows");
  }
  const rows = (result as { rows: unknown }).rows;
  if (!Array.isArray(rows))
    throw new Error("browser mock rows are not an array");
  return rows as Record<string, unknown>[];
}

function assertBrowserTableSubset(
  browserRows: Record<string, unknown>[],
  schemaContract: SchemaContract,
): void {
  for (const row of browserRows) {
    const tableName = String(row.name);
    const physical = schemaContract.tables[tableName];
    expect(
      physical,
      `browser table ${tableName} must exist in Rust contract`,
    ).toBeDefined();

    const columns = row.columns;
    if (!Array.isArray(columns)) {
      throw new Error(`browser table ${tableName} has no introspected columns`);
    }
    for (const column of columns) {
      const columnName = String(column.name);
      const expected = physical.columns[columnName];
      expect(
        expected,
        `browser column ${tableName}.${columnName} must exist in Rust contract`,
      ).toBeDefined();
      expect(normalizeType(String(column.type))).toBe(expected.declaredType);
      expect(Boolean(Number(column.notnull)) || Number(column.pk) > 0).toBe(
        expected.notNull || expected.primaryKey > 0,
      );
      if (column.dflt_value !== null && column.dflt_value !== undefined) {
        expect(column.dflt_value).toBe(expected.default);
      }
      expect(Number(column.pk)).toBe(expected.primaryKey);
    }
  }
}

describe("schema contract", () => {
  it("keeps every Drizzle table and renderer column inside the Rust physical schema", () => {
    const schemaContract: SchemaContract = contract;
    const drizzleTables = collectDrizzleTables();
    const drizzleTableNames = Object.keys(drizzleTables).sort();
    const contractTableNames = Object.keys(schemaContract.tables).sort();
    const rustOnlyTableNames = contractTableNames.filter((name) =>
      RUST_ONLY_TABLES.has(name),
    );

    expect(rustOnlyTableNames).toEqual([...RUST_ONLY_TABLES].sort());
    expect(
      contractTableNames.filter((name) => !RUST_ONLY_TABLES.has(name)),
    ).toEqual(drizzleTableNames);

    for (const [tableName, table] of Object.entries(drizzleTables)) {
      const physical = schemaContract.tables[tableName];
      expect(physical).toBeDefined();
      const tableConfig = getTableConfig(table);
      const drizzleColumns = getTableColumns(table);
      const drizzleColumnNames = Object.values(drizzleColumns).map(
        (column) => column.name,
      );

      for (const column of Object.values(drizzleColumns)) {
        const physicalColumn = physical.columns[column.name];
        expect(
          physicalColumn,
          `Drizzle column ${tableName}.${column.name} must exist in Rust contract`,
        ).toBeDefined();
        expect(
          physicalColumn.notNull || physicalColumn.primaryKey > 0,
          `${tableName}.${column.name} NOT NULL drift`,
        ).toBe(column.notNull);
        expect(
          normalizeType((column as SQLiteColumn).getSQLType()),
          `${tableName}.${column.name} type drift`,
        ).toBe(physicalColumn.declaredType);
        if (column.default !== undefined) {
          const drizzleDefault = normalizeDefault(column.default);
          if (drizzleDefault === undefined) {
            expect(
              physicalColumn.default,
              `${tableName}.${column.name} must retain a database default`,
            ).not.toBeNull();
          } else {
            expect(
              normalizeDefault(physicalColumn.default),
              `${tableName}.${column.name} DEFAULT drift`,
            ).toBe(drizzleDefault);
          }
        }
        if (column.primary) {
          expect(physicalColumn.primaryKey).toBeGreaterThan(0);
        }
      }

      for (const foreignKey of tableConfig.foreignKeys) {
        const reference = foreignKey.reference();
        const foreignTable = getTableConfig(reference.foreignTable).name;
        expect(reference.columns).toHaveLength(reference.foreignColumns.length);
        for (const [index, localColumn] of reference.columns.entries()) {
          const foreignColumn = reference.foreignColumns[index];
          expect(
            physical.foreignKeys.some(
              (candidate) =>
                candidate.table === foreignTable &&
                candidate.from === localColumn.name &&
                candidate.to === foreignColumn.name &&
                candidate.onDelete ===
                  normalizeForeignKeyAction(foreignKey.onDelete) &&
                candidate.onUpdate ===
                  normalizeForeignKeyAction(foreignKey.onUpdate),
            ),
            `${tableName}.${localColumn.name} FK drift`,
          ).toBe(true);
        }
      }

      const declaredPrimaryKeyColumns = tableConfig.primaryKeys.flatMap(
        (primaryKey) => primaryKey.columns.map((column) => column.name),
      );
      if (declaredPrimaryKeyColumns.length > 0) {
        const physicalPrimaryKeyColumns = Object.entries(physical.columns)
          .filter(([, column]) => column.primaryKey > 0)
          .sort(([, left], [, right]) => left.primaryKey - right.primaryKey)
          .map(([columnName]) => columnName);
        expect(physicalPrimaryKeyColumns).toEqual(declaredPrimaryKeyColumns);
      }

      for (const index of tableConfig.indexes) {
        const physicalIndex = schemaContract.indexes[index.config.name];
        const declaredColumns = index.config.columns.map((column) =>
          "name" in column ? column.name : null,
        );
        if (!physicalIndex) {
          expect(
            index.config.unique,
            `unmatched Drizzle index ${index.config.name} must be unique`,
          ).toBe(true);
          expect(
            physical.uniqueConstraints.some(
              (constraint) =>
                constraint.columns.length === declaredColumns.length &&
                constraint.columns.every(
                  (column, index) => column === declaredColumns[index],
                ),
            ),
            `Drizzle unique index ${index.config.name} must match a Rust UNIQUE constraint`,
          ).toBe(true);
        } else {
          expect(physicalIndex.table).toBe(tableName);
          expect(physicalIndex.unique).toBe(index.config.unique);
          expect(physicalIndex.columns.map((column) => column.column)).toEqual(
            declaredColumns,
          );
        }
      }

      const allowedRustOnlyColumns = RUST_ONLY_COLUMNS[tableName] ?? new Set();
      const unexpectedPhysicalColumns = Object.keys(physical.columns).filter(
        (columnName) =>
          !drizzleColumnNames.includes(columnName) &&
          !allowedRustOnlyColumns.has(columnName),
      );
      expect(unexpectedPhysicalColumns).toEqual([]);
    }
  });

  it("keeps the browser mock as an explicit physical-schema subset", async () => {
    const schemaContract: SchemaContract = contract;
    const browser = await createBrowserMock();
    const tableRows = queryRows(
      await browser.invoke("db_execute", {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        params: [],
        method: "all",
      }),
    );
    const tableNames = tableRows.map((row) => String(row.name)).sort();
    expect(tableNames).toEqual(BROWSER_SCHEMA_TABLES);

    for (const row of tableRows) {
      const tableName = String(row.name);
      const columns = queryRows(
        await browser.invoke("db_execute", {
          sql: 'SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid',
          params: [tableName],
          method: "all",
        }),
      );
      (row as { columns: Record<string, unknown>[] }).columns = columns;
    }

    assertBrowserTableSubset(tableRows, schemaContract);
  });
});
