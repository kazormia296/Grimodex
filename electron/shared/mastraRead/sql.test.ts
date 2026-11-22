import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { checkReadSql } from "./sql.js";
import { CHECKER_FIXTURE_TABLE_SET } from "./sql.testSupport.js";

const check = (sql: unknown) => checkReadSql(sql, CHECKER_FIXTURE_TABLE_SET);

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
      "SQLite's six white space characters (VT, FF, CR)",
      "select\u000b1\u000cfrom\r\nprojects",
      ["projects"],
    ],
    [
      "non-ASCII inside a string, a quoted identifier and a comment",
      "select '日本語', \"名前\" from projects /* 注 */ where id = ?",
      ["projects"],
    ],
    [
      "?N placeholders",
      "select ?1, ?2 from projects where id = ?3",
      ["projects"],
    ],
    [
      "limit and offset",
      "select 1 from projects limit 1 offset 2",
      ["projects"],
    ],
    [
      "a table with an alias, with and without as",
      'select 1 from projects p join tree_nodes as n on n.project_id = p.id join snippets "s" on 1',
      ["projects", "tree_nodes", "snippets"],
    ],
    [
      "join words, using, natural",
      "select 1 from projects left outer join snippets using (id) natural join events cross join tree_nodes",
      ["projects", "snippets", "events", "tree_nodes"],
    ],
    [
      "a column named like a join word or offset after a dot",
      "select 1 from projects p join snippets s on p.left = s.offset and p.window = s.right",
      ["projects", "snippets"],
    ],
    [
      "a subquery in from with an alias, then a join",
      "select 1 from (select id from projects) x left join snippets on snippets.id = x.id",
      ["projects", "snippets"],
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
    [
      "a doubly parenthesised subquery",
      "select 1 from ((select id from tree_nodes))",
      "table-unreadable",
    ],
    [
      "offset as an alias, then a comma join",
      "select * from projects offset, secrets",
      "table-unreadable",
    ],
    [
      "as offset, then a comma join",
      "select * from projects as offset, secrets",
      "table-unreadable",
    ],
    [
      "window as an alias, then a comma join",
      "select * from projects window, secrets",
      "table-unreadable",
    ],
    [
      "a subquery aliased offset, then a comma join",
      "select * from (select 1) offset, secrets",
      "table-unreadable",
    ],
    [
      "offset in a join condition",
      "select * from projects join snippets on 1 offset, secrets",
      "table-unreadable",
    ],
    [
      "a comma list in a double parenthesis",
      "select * from ((select 1), secrets)",
      "table-unreadable",
    ],
    [
      "a comma list in a parenthesis after join",
      "select * from projects join ((select 1), secrets)",
      "table-unreadable",
    ],
    [
      "a parenthesis after join, then select in a second one",
      "select * from projects join (((select 1)), secrets)",
      "table-unreadable",
    ],
    [
      "two names after a table",
      "select * from projects a b",
      "table-unreadable",
    ],
    ["a three-part name", "select * from main.projects.x", "table-unreadable"],
    [
      "indexed by",
      "select * from projects indexed by i, secrets",
      "table-unreadable",
    ],
    [
      "a string as an alias",
      "select * from projects 'x', secrets",
      "table-unreadable",
    ],
    ["as with no alias", "select * from projects as", "table-unreadable"],
    [
      "a join word, then a comma",
      "select * from projects left, secrets",
      "table-unreadable",
    ],
    [
      "natural join of a closed table",
      "select * from projects natural join secrets",
      "table-not-allowed",
    ],
    [
      "a join that has no table",
      "select * from projects left join",
      "table-unreadable",
    ],
    [
      "a placeholder that eats the next word (?from)",
      "select ?from secrets",
      "table-not-allowed",
    ],
    [
      "?N that eats the next word (?1from)",
      "select v,?1from secrets",
      "table-not-allowed",
    ],
    [
      "a Tcl variable that swallows a parenthesis ($)",
      "select * from projects left join snippets on $a(() , secrets",
      "unlexable",
    ],
    [
      "a Tcl variable (:)",
      "select * from projects left join snippets on :a(() , secrets",
      "unlexable",
    ],
    [
      "a Tcl variable (@)",
      "select * from projects left join snippets on @a(() , secrets",
      "unlexable",
    ],
    [
      "a Tcl variable (#)",
      "select * from projects left join snippets on #a(() , secrets",
      "unlexable",
    ],
    [
      "a named placeholder",
      "select * from projects where id = :id",
      "unlexable",
    ],
    [
      "a no-break space where SQLite sees a name",
      "select * from projects where\u00a0, secrets",
      "unlexable",
    ],
    [
      "a no-break space in front of offset",
      "select * from projects\u00a0offset, secrets",
      "unlexable",
    ],
    [
      "a BOM in front of offset",
      "select * from projects \ufeffoffset, secrets",
      "unlexable",
    ],
    [
      "a BOM after offset",
      "select * from projects offset\ufeff, secrets",
      "unlexable",
    ],
    [
      "an em space after offset",
      "select * from projects offset\u2003, secrets",
      "unlexable",
    ],
    [
      "an ideographic space",
      "select * from projects where\u3000, secrets",
      "unlexable",
    ],
    ["a non-ASCII word", "select * from projects, \u7ba1\u7406", "unlexable"],
    ["an unopened bracket close", "select 1 from projects ]", "unlexable"],
    [
      "an open parenthesis at the end",
      "select 1 from projects where ((",
      "unlexable",
    ],
    [
      "an open parenthesis before a closed table",
      "select (1 from projects",
      "unlexable",
    ],
    [
      "an open parenthesis with a trailing semicolon",
      "select 1 from projects where (id = 1;",
      "unlexable",
    ],
    ["a NUL inside a string", "select 'a\u0000b' from projects", "unlexable"],
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

describe("checkReadSql: the refused bypasses are real in SQLite", () => {
  // Each text below was accepted by an earlier version of the check and is read
  // by SQLite as a statement that reads `secrets`, a table outside the
  // allowlist. This proves the corpus is made of live exploits, not of texts
  // SQLite would have rejected anyway.
  const bypasses = [
    "select * from projects offset, secrets",
    "select * from projects as offset, secrets",
    "select * from projects window, secrets",
    "select * from (select 1) offset, secrets",
    "select * from ((select 1), secrets)",
    "select * from projects join ((select 1), secrets)",
    "select * from projects \ufeffoffset, secrets",
    "select * from projects offset\u2003, secrets",
    "select * from projects where\u3000, secrets",
    "select ?from secrets",
    "select v,?1from secrets",
    "select * from projects left join snippets on $a(() , secrets",
    "select * from projects left join snippets on :a(() , secrets",
    "select * from projects left join snippets on @a(() , secrets",
    "select * from projects left join snippets on #a(() , secrets",
  ];
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table projects (id, v);
    create table snippets (id, v);
    create table secrets (v, id);
    insert into projects values (1, 'p');
    insert into snippets values (1, 's');
    insert into secrets values ('SECRET', 1), ('SECRET', 2);
  `);

  it.each(bypasses)("%j reads secrets and is refused", (statement) => {
    const rows = sqlite.prepare(statement).all();
    // `?from` names no column of secrets; it still returns one row per secret.
    expect(JSON.stringify(rows).includes("SECRET") || rows.length === 2).toBe(
      true,
    );
    expect(check(statement).ok).toBe(false);
  });
});
