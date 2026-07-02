import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { codexEntries, snippets, treeNodes } from "./schema";

// `version` 列は src-tauri/src/database/migrate.rs:1659-1666 が
// codex_entries に追加済み（AI write 基盤の OCC）。Drizzle 側 schema は
// それを認識していなかったため、人間保存経路で条件付き version 更新を
// 行うには Drizzle column としても定義しておく必要がある。
describe("codexEntries.version column", () => {
  it("exists as a column (mirrors migrate.rs add_column_if_missing)", () => {
    const cols = getTableColumns(codexEntries);
    expect(cols.version).toBeDefined();
  });

  it("maps to snake_case db column 'version'", () => {
    const cols = getTableColumns(codexEntries);
    expect(cols.version.name).toBe("version");
  });
});

// snippets / tree_nodes も migrate.rs の add_column_if_missing で version 列を
// 持つ（M4: OCC version bump 配線の対象）。codex と同型のミラー宣言を担保する。
describe("snippets.version column", () => {
  it("exists as a column (mirrors migrate.rs add_column_if_missing)", () => {
    const cols = getTableColumns(snippets);
    expect(cols.version).toBeDefined();
  });

  it("maps to snake_case db column 'version'", () => {
    const cols = getTableColumns(snippets);
    expect(cols.version.name).toBe("version");
  });
});

describe("treeNodes.version column", () => {
  it("exists as a column (mirrors migrate.rs add_column_if_missing)", () => {
    const cols = getTableColumns(treeNodes);
    expect(cols.version).toBeDefined();
  });

  it("maps to snake_case db column 'version'", () => {
    const cols = getTableColumns(treeNodes);
    expect(cols.version.name).toBe("version");
  });
});
