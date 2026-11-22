// What Drizzle (0.45.x, `sqlite-proxy`) really emits for the select shapes the
// read tools will use must pass `checkReadSql`; a refusal of one of these would
// be a false refusal in a turn. Each statement is also prepared by SQLite
// itself (`node:sqlite`), so a shape here is one SQLite accepts, not only one
// the lexer accepts.
//
// The shapes Drizzle cannot use through this port are listed at the end:
// `with` (the first code token must be `select`), `.get()` (see
// `mastraRead/db.ts`), a table-valued function, `offset` right after a table.
import { DatabaseSync } from "node:sqlite";

import {
  and,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  like,
  notInArray,
  or,
  relations,
  sql,
} from "drizzle-orm";
import {
  alias,
  integer,
  intersect,
  sqliteTable,
  text,
  union,
  unionAll,
  except,
} from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import { checkReadSql } from "./sql.js";
import { CHECKER_FIXTURE_TABLE_SET } from "./sql.testSupport.js";

const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const treeNodes = sqliteTable("tree_nodes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  version: integer("version").notNull(),
  deletedAt: text("deleted_at"),
});
const snippets = sqliteTable("snippets", {
  id: text("id").primaryKey(),
  treeNodeId: text("tree_node_id").notNull(),
  body: text("body").notNull(),
});
const codexEntries = sqliteTable("codex_entries", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  meta: text("meta"),
});
const codexTags = sqliteTable("codex_tags", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
});
const codexEntryTags = sqliteTable("codex_entry_tags", {
  entryId: text("entry_id").notNull(),
  tagId: text("tag_id").notNull(),
});
const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
});

const treeNodesRelations = relations(treeNodes, ({ many }) => ({
  snippets: many(snippets),
}));
const snippetsRelations = relations(snippets, ({ one }) => ({
  node: one(treeNodes, {
    fields: [snippets.treeNodeId],
    references: [treeNodes.id],
  }),
}));
const codexEntriesRelations = relations(codexEntries, ({ many }) => ({
  entryTags: many(codexEntryTags),
}));
const codexEntryTagsRelations = relations(codexEntryTags, ({ one }) => ({
  tag: one(codexTags, {
    fields: [codexEntryTags.tagId],
    references: [codexTags.id],
  }),
  entry: one(codexEntries, {
    fields: [codexEntryTags.entryId],
    references: [codexEntries.id],
  }),
}));

const schema = {
  projects,
  treeNodes,
  snippets,
  codexEntries,
  codexTags,
  codexEntryTags,
  events,
  treeNodesRelations,
  snippetsRelations,
  codexEntriesRelations,
  codexEntryTagsRelations,
};

interface Captured {
  readonly sql: string;
  readonly method: string;
}

/** A Drizzle db whose proxy records the statement and answers no rows. */
function capturingDb() {
  const captured: Captured[] = [];
  const db = drizzle(
    async (statement, _params, method) => {
      captured.push({ sql: statement, method });
      // `$count` reads `rows[0][0]`; everything else takes no rows.
      return { rows: method === "values" ? [[0]] : [] };
    },
    { schema },
  );
  return { db, captured };
}

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
  create table projects (id text primary key, name text not null);
  create table tree_nodes (id text primary key, project_id text not null, parent_id text, title text not null, version integer not null, deleted_at text);
  create table snippets (id text primary key, tree_node_id text not null, body text not null);
  create table codex_entries (id text primary key, project_id text not null, name text not null, meta text);
  create table codex_tags (id text primary key, label text not null);
  create table codex_entry_tags (entry_id text not null, tag_id text not null);
  create table events (id text primary key, project_id text not null, title text not null);
`);

describe("checkReadSql: what Drizzle 0.45 emits is not refused", () => {
  const { db } = capturingDb();
  const nodeAlias = alias(treeNodes, "n");
  const parentAlias = alias(treeNodes, "parent");
  const sub = db
    .select({ id: snippets.treeNodeId, total: count().as("total") })
    .from(snippets)
    .groupBy(snippets.treeNodeId)
    .as("sub");

  type Case = readonly [
    name: string,
    run: (db: ReturnType<typeof capturingDb>["db"]) => PromiseLike<unknown>,
    tables: readonly string[],
  ];
  const cases: readonly Case[] = [
    [
      "columns, where, a placeholder",
      (d) =>
        d
          .select({ id: treeNodes.id, title: treeNodes.title })
          .from(treeNodes)
          .where(eq(treeNodes.projectId, "p")),
      ["tree_nodes"],
    ],
    [
      "all columns of a table",
      (d) => d.select().from(codexEntries),
      ["codex_entries"],
    ],
    [
      "columns in another order than the table's",
      (d) =>
        d
          .select({
            version: treeNodes.version,
            title: treeNodes.title,
            id: treeNodes.id,
          })
          .from(treeNodes),
      ["tree_nodes"],
    ],
    [
      "and / or / isNull / like / gt",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(
            and(
              isNull(treeNodes.deletedAt),
              or(like(treeNodes.title, "%a%"), gt(treeNodes.version, 1)),
            ),
          ),
      ["tree_nodes"],
    ],
    [
      "left join, inner join",
      (d) =>
        d
          .select({ id: treeNodes.id, body: snippets.body })
          .from(treeNodes)
          .leftJoin(snippets, eq(snippets.treeNodeId, treeNodes.id))
          .innerJoin(projects, eq(projects.id, treeNodes.projectId)),
      ["tree_nodes", "snippets", "projects"],
    ],
    [
      "right join, full join, cross join",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .rightJoin(snippets, eq(snippets.treeNodeId, treeNodes.id))
          .fullJoin(codexTags, eq(codexTags.id, treeNodes.id))
          .crossJoin(projects),
      ["tree_nodes", "snippets", "codex_tags", "projects"],
    ],
    [
      "a table alias, and a self join through two",
      (d) =>
        d
          .select({ id: nodeAlias.id, parentTitle: parentAlias.title })
          .from(nodeAlias)
          .leftJoin(parentAlias, eq(parentAlias.id, nodeAlias.parentId)),
      ["tree_nodes", "tree_nodes"],
    ],
    [
      "in with a list",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(inArray(treeNodes.id, ["a", "b", "c"])),
      ["tree_nodes"],
    ],
    [
      "not in with a list",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(notInArray(treeNodes.id, ["a", "b"])),
      ["tree_nodes"],
    ],
    [
      "an empty inArray, which Drizzle writes as `false`",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(inArray(treeNodes.id, [])),
      ["tree_nodes"],
    ],
    [
      "in with a subquery",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(
            inArray(
              treeNodes.id,
              d.select({ id: snippets.treeNodeId }).from(snippets),
            ),
          ),
      ["tree_nodes", "snippets"],
    ],
    [
      "exists with a correlated subquery",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .where(
            exists(
              d
                .select({ one: sql`1` })
                .from(snippets)
                .where(eq(snippets.treeNodeId, treeNodes.id)),
            ),
          ),
      ["tree_nodes", "snippets"],
    ],
    [
      "$count with a filter",
      (d) => d.$count(treeNodes, eq(treeNodes.projectId, "p")),
      ["tree_nodes"],
    ],
    [
      "$count inside a select",
      (d) =>
        d
          .select({
            id: projects.id,
            total: d.$count(treeNodes, eq(treeNodes.projectId, projects.id)),
          })
          .from(projects),
      ["tree_nodes", "projects"],
    ],
    [
      "group by, having, an aggregate",
      (d) =>
        d
          .select({ node: snippets.treeNodeId, n: count() })
          .from(snippets)
          .groupBy(snippets.treeNodeId)
          .having(gt(count(), 1)),
      ["snippets"],
    ],
    [
      "order by, limit and offset",
      (d) =>
        d
          .select({ id: treeNodes.id })
          .from(treeNodes)
          .orderBy(treeNodes.title, sql`${treeNodes.version} desc`)
          .limit(5)
          .offset(10),
      ["tree_nodes"],
    ],
    [
      "distinct",
      (d) => d.selectDistinct({ id: treeNodes.projectId }).from(treeNodes),
      ["tree_nodes"],
    ],
    [
      "union",
      (d) =>
        union(
          d.select({ id: treeNodes.id }).from(treeNodes),
          d.select({ id: snippets.id }).from(snippets),
        ),
      ["tree_nodes", "snippets"],
    ],
    [
      "union all with order and limit",
      (d) =>
        unionAll(
          d.select({ id: treeNodes.id }).from(treeNodes),
          d.select({ id: snippets.id }).from(snippets),
        )
          .orderBy(treeNodes.id)
          .limit(3),
      ["tree_nodes", "snippets"],
    ],
    [
      "intersect and except",
      (d) =>
        except(
          intersect(
            d.select({ id: treeNodes.id }).from(treeNodes),
            d.select({ id: snippets.id }).from(snippets),
          ),
          d.select({ id: events.id }).from(events),
        ),
      ["tree_nodes", "snippets", "events"],
    ],
    [
      "a subquery in from, with an alias and no `as`",
      (d) =>
        d
          .select({ id: sub.id, total: sub.total })
          .from(sub)
          .where(gt(sub.total, 2)),
      ["snippets"],
    ],
    [
      "a join on a subquery",
      (d) =>
        d
          .select({ id: treeNodes.id, total: sub.total })
          .from(treeNodes)
          .leftJoin(sub, eq(sub.id, treeNodes.id)),
      ["tree_nodes", "snippets"],
    ],
    [
      "a json function in a sql template",
      (d) =>
        d
          .select({ v: sql<string>`json_extract(${codexEntries.meta}, '$.a')` })
          .from(codexEntries)
          .where(sql`json_valid(${codexEntries.meta})`),
      ["codex_entries"],
    ],
    [
      "relational findMany",
      (d) =>
        d.query.treeNodes.findMany({ where: eq(treeNodes.projectId, "p") }),
      ["tree_nodes"],
    ],
    [
      "relational findMany with a many relation, limit and order",
      (d) =>
        d.query.treeNodes.findMany({
          with: { snippets: { limit: 2, orderBy: snippets.id } },
          where: (t, { eq: e }) => e(t.projectId, "p"),
          orderBy: treeNodes.title,
          limit: 10,
          offset: 5,
        }),
      ["tree_nodes", "snippets"],
    ],
    [
      "relational findMany with a nested relation (json_group_array inside)",
      (d) =>
        d.query.codexEntries.findMany({
          columns: { id: true, name: true },
          with: { entryTags: { with: { tag: true } } },
          where: (t, { inArray: i }) => i(t.id, ["a", "b"]),
        }),
      ["codex_entries", "codex_entry_tags", "codex_tags"],
    ],
    [
      "relational findMany with a one relation",
      (d) => d.query.snippets.findMany({ with: { node: true } }),
      ["snippets", "tree_nodes"],
    ],
  ];

  it.each(cases)("%s", async (_name, run, tables) => {
    const { db: captureDb, captured } = capturingDb();
    await run(captureDb);
    expect(captured.length).toBeGreaterThan(0);
    for (const { sql: statement, method } of captured) {
      expect(["all", "values"]).toContain(method);
      expect(checkReadSql(statement, CHECKER_FIXTURE_TABLE_SET)).toEqual({
        ok: true,
        tables: expect.arrayContaining([...new Set(tables)]),
      });
      // SQLite itself accepts the same text.
      expect(() => sqlite.prepare(statement)).not.toThrow();
    }
  });
});

describe("checkReadSql: Drizzle shapes this port does not send", () => {
  it("refuses `with`, which a core cannot use (db.$with / db.with)", async () => {
    const { db, captured } = capturingDb();
    const cte = db.$with("c").as(db.select().from(treeNodes));
    await db.with(cte).select().from(cte);
    expect(captured).toHaveLength(1);
    expect(
      checkReadSql(captured[0]!.sql, CHECKER_FIXTURE_TABLE_SET),
    ).toMatchObject({
      ok: false,
      code: "not-select",
    });
  });

  it("emits `get` for findFirst and .get(), which db.ts does not send", async () => {
    const { db, captured } = capturingDb();
    await db.select().from(treeNodes).limit(1).get();
    await db.query.treeNodes.findFirst();
    expect(captured.map((c) => c.method)).toEqual(["get", "get"]);
  });
});
