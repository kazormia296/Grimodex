import { describe, expect, it } from "vitest";

import { checkReadSql } from "./sql.js";
import { MAIN_READ_TABLE_SET } from "./tables.js";

const check = (sql: unknown) => checkReadSql(sql, MAIN_READ_TABLE_SET);

describe("checkReadSql: a statement that is sent", () => {
  it.each([
    [
      "Drizzle's lower-case select",
      'select "id", "title" from "tree_nodes" where "tree_nodes"."project_id" = ?',
      ["tree_nodes"],
    ],
    ["upper case", "SELECT * FROM TREE_NODES", ["tree_nodes"]],
    ["leading white space", "  \n\t select 1", []],
    ["a leading line comment", "-- note\nselect 1 from projects", ["projects"]],
    ["a leading block comment", "/* x */ SELECT 1 FROM snippets", ["snippets"]],
    ["a trailing semicolon", "select 1 from events;", ["events"]],
    [
      "a join",
      'select "a"."id" from "tree_nodes" left join "codex_entries" on "a"."id" = "b"."id" join "projects" on 1',
      ["tree_nodes", "codex_entries", "projects"],
    ],
    [
      "a subquery in where",
      "select id from tree_nodes where id in (select scene_id from scene_events where a in (?, ?))",
      ["tree_nodes", "scene_events"],
    ],
    [
      "a subquery in from, with commas inside",
      "select x.a from (select a, b from tree_nodes) as x",
      ["tree_nodes"],
    ],
    [
      "a subquery in the select list",
      "select (select count(*) from snippets), id from projects",
      ["snippets", "projects"],
    ],
    [
      "a compound select (commas after a union)",
      "select a from events union all select b, c from foreshadows order by 1, 2 limit 1, 2",
      ["events", "foreshadows"],
    ],
    [
      "a function call with commas in a join condition",
      "select 1 from tree_nodes join codex_entries on coalesce(a, b) = c",
      ["tree_nodes", "codex_entries"],
    ],
    ["the main schema", 'select 1 from main."tree_nodes"', ["tree_nodes"]],
    [
      "a doubly parenthesised subquery",
      "select 1 from ((select id from tree_nodes))",
      ["tree_nodes"],
    ],
    [
      "in with a list and not in with a subquery",
      "select 1 from tree_nodes where a in (?, ?) and b not in (select id from events)",
      ["tree_nodes", "events"],
    ],
    [
      "a string with a semicolon and a keyword",
      "select 'a; from x' from projects",
      ["projects"],
    ],
    [
      "a quoted word that is a keyword",
      'select "from" from projects',
      ["projects"],
    ],
    [
      "a bracket and a backtick identifier",
      "select 1 from [tree_nodes] join `codex_tags` on 1",
      ["tree_nodes", "codex_tags"],
    ],
  ])("%s", (_name, sql, tables) => {
    expect(check(sql)).toEqual({ ok: true, tables });
  });
});

describe("checkReadSql: a statement that is refused", () => {
  it.each([
    [
      "with ... delete",
      "with t as (select 1) delete from tree_nodes where 0",
      "not-select",
    ],
    ["with ... select", "with t as (select 1) select * from t", "not-select"],
    ["delete", "delete from tree_nodes", "not-select"],
    ["update", "update tree_nodes set title = 'x'", "not-select"],
    ["insert", "insert into snippets(id) values (1)", "not-select"],
    ["pragma", "pragma user_version", "not-select"],
    ["explain", "explain select 1", "not-select"],
    ["values", "values (1)", "not-select"],
    ["a parenthesised select", "(select 1)", "not-select"],
    ["a word that only starts with select", "selectx 1", "not-select"],
    ["empty", "", "not-select"],
    ["only a comment", "-- select 1", "not-select"],
    ["a quoted select", '"select" 1', "not-select"],
    ["two statements", "select 1; delete from tree_nodes", "multi-statement"],
    ["two terminators", "select 1;;", "multi-statement"],
    ["a comma join", "select 1 from tree_nodes, codex_entries", "comma-join"],
    [
      "a comma join after a join",
      "select 1 from tree_nodes join projects on 1, snippets",
      "comma-join",
    ],
    ["a table-valued function", "select * from json_each(?)", "table-function"],
    [
      "a pragma function",
      "select * from pragma_table_info('x')",
      "table-function",
    ],
    ["the schema table", "select * from sqlite_master", "table-not-allowed"],
    [
      "an attached schema",
      "select * from temp.tree_nodes",
      "table-not-allowed",
    ],
    ["a closed table", "select * from narrative_runs", "table-not-allowed"],
    ["the audit ledger", "select * from ai_audit_events", "table-not-allowed"],
    ["a chat table", "select * from chat_messages", "table-not-allowed"],
    [
      "a closed table in a join",
      "select 1 from tree_nodes join chat_messages on 1",
      "table-not-allowed",
    ],
    [
      "a closed table in a subquery",
      "select 1 from tree_nodes where id in (select id from narrative_runs)",
      "table-not-allowed",
    ],
    [
      "a closed table in a from subquery",
      "select 1 from (select 1 from nir1_x)",
      "table-not-allowed",
    ],
    ["from without a table", "select 1 from", "table-unreadable"],
    [
      "a parenthesised table name",
      "select * from (ai_audit_events)",
      "table-unreadable",
    ],
    [
      "a parenthesised allowed table (also not read)",
      "select * from (tree_nodes)",
      "table-unreadable",
    ],
    [
      "a parenthesised list of tables",
      "select * from (tree_nodes, chat_messages)",
      "table-unreadable",
    ],
    [
      "a parenthesised join",
      "select 1 from tree_nodes join (codex_entries join chat_messages on 1) on 1",
      "table-unreadable",
    ],
    [
      "in with a bare table name",
      "select 1 from tree_nodes where id in ai_audit_events",
      "table-unreadable",
    ],
    [
      "not in with a bare table name",
      "select 1 from tree_nodes where id not in chat_messages",
      "table-unreadable",
    ],
    [
      "in with a table-valued function",
      "select 1 from tree_nodes where id in json_each(?)",
      "table-unreadable",
    ],
    [
      "from followed by a number",
      "select substr(x from 2) from projects",
      "table-unreadable",
    ],
    ["an unterminated string", "select 'a from projects", "unlexable"],
    ["an unterminated block comment", "select 1 /* from projects", "unlexable"],
    [
      "an unterminated quoted identifier",
      'select 1 from "projects',
      "unlexable",
    ],
    ["a NUL character", "select 1\u0000; delete from tree_nodes", "unlexable"],
    ["an unbalanced parenthesis", "select 1) from projects", "unlexable"],
  ])("%s", (_name, sql, code) => {
    const result = check(sql);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.code).toBe(code);
  });

  it("refuses what is not a string", () => {
    for (const value of [undefined, null, 1, {}, ["select 1"]]) {
      expect(check(value)).toMatchObject({ ok: false, code: "not-select" });
    }
  });

  it("names the table that was refused", () => {
    expect(check("select 1 from narrative_runs")).toMatchObject({
      ok: false,
      detail: "narrative_runs",
    });
  });
});
