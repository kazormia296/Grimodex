import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreCodexEntryContext,
  type CoreReadDbClient,
} from "../../mastraRead/ports.js";
import { extractPlainText } from "../features/codex/prosemirrorTextExtractor.js";
import {
  readCodexDetailValues,
  readCodexPhaseDetailOverrides,
  readCodexPhases,
} from "./codexReaders.js";
import { assembleCodexEntry, getCodexEntry } from "./codexEntryTools.js";
import { createCoreReadDb } from "./readDb.js";
import { buildReadInputs } from "./readInputs.js";

const T = "2026-01-01T00:00:00.000Z";
const document = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

function harness(
  options: {
    readonly projectId?: string;
    readonly scenes?: readonly (string | null)[];
  } = {},
) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    create table codex_entries (
      id text primary key, project_id text, parent_id text, type text, name text,
      aliases text, excluded_aliases text, readings text, summary text, content text,
      icon text, tags_cache text, context_mode text, children_budget text,
      source_chat_message_id text, notes text, created_at text, updated_at text,
      version integer
    );
    create table codex_entry_phases (
      id text primary key, entry_id text, anchor_node_id text, label text,
      summary_override text, content_override text, context_mode_override text,
      created_at text, updated_at text, version integer
    );
    create table codex_detail_definitions (
      id text primary key, project_id text, type_slug text, name text, field_type text,
      field_config text, sort_order real, include_in_context integer, version integer,
      created_at text, updated_at text
    );
    create table codex_detail_values (
      id text primary key, entry_id text, definition_id text, value text,
      version integer, created_at text, updated_at text
    );
    create table codex_phase_detail_overrides (
      phase_id text, definition_id text, value text
    );
    insert into codex_entries
      (id, project_id, parent_id, type, name, aliases, summary, content, context_mode, created_at, updated_at, version)
      values
        ('e-public', 'p-main', null, 'character', '親', '["別名"]', '公開要約', '${document("公開本文")}', 'mentioned', '${T}', '${T}', 0),
        ('e-hidden', 'p-main', null, 'character', '非公開', null, 'SECRET-BASE-SUMMARY', '${document("SECRET-BASE")}', 'hidden', '${T}', '${T}', 0),
        ('e-release', 'p-main', null, 'character', '解除', null, 'SECRET-BASE-SUMMARY', '${document("SECRET-BASE")}', 'hidden', '${T}', '${T}', 0),
        ('e-child', 'p-main', 'e-public', 'character', '子', null, '子要約', '${document("子本文")}', 'mentioned', '${T}', '${T}', 0);
    insert into codex_entry_phases
      (id, entry_id, anchor_node_id, label, summary_override, content_override, context_mode_override, created_at, updated_at, version)
      values
        ('ph-release-old', 'e-release', 'n-s1', 'old', 'SECRET-PHASE-OLD-SUMMARY', '${document("SECRET-PHASE-OLD")}', 'hidden', '${T}', '${T}', 0),
        ('ph-release', 'e-release', 'n-s2', 'release', '解除後の要約', null, 'mentioned', '${T}', '${T}', 0),
        ('ph-child-hide', 'e-child', 'n-s2', 'hide child', null, null, 'hidden', '${T}', '${T}', 0);
    insert into codex_detail_definitions
      (id, project_id, type_slug, name, field_type, sort_order, include_in_context, version, created_at, updated_at)
      values
        ('d-age', 'p-main', 'character', '年齢', 'text', 1, 1, 0, '${T}', '${T}'),
        ('d-private', 'p-main', 'character', '非公開詳細', 'text', 2, 0, 0, '${T}', '${T}'),
        ('d-other', 'p-other', 'character', '別 project の項目名', 'text', 1, 1, 0, '${T}', '${T}');
    insert into codex_detail_values
      (id, entry_id, definition_id, value, version, created_at, updated_at)
      values
        ('v-public', 'e-public', 'd-age', '18', 0, '${T}', '${T}'),
        ('v-release-base', 'e-release', 'd-age', 'SECRET-BASE-DETAIL', 0, '${T}', '${T}');
    insert into codex_phase_detail_overrides (phase_id, definition_id, value)
      values ('ph-release', 'd-age', 'Phase 解決後の年齢');
  `);

  const sent: Array<{ sql: string; params: unknown }> = [];
  const client: CoreReadDbClient = async (sql, params) => {
    sent.push({ sql, params });
    return {
      rows: sqlite
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => Object.values(row as object)),
    };
  };
  const db = createCoreReadDb(client);
  const inputs = buildReadInputs({
    projectId: options.projectId ?? "p-main",
    treeRows: ["n-s1", "n-s2"].map((id, index) => ({
      id,
      parentId: null,
      nodeType: "scene",
      sortOrder: `a${index}`,
      storyTimeOrder: null,
      archivedAt: null,
    })),
    project: { phaseResolutionMode: "reading" },
    currentSceneId: "n-s2",
  });
  let treeReads = 0;
  const scenes = options.scenes ?? ["n-s2"];
  const ctx: CoreCodexEntryContext = {
    getDb: () => db,
    getTreeState: () => ({
      projectId: options.projectId ?? "p-main",
      nodes: [],
      activeSceneId: scenes[Math.min(treeReads++, scenes.length - 1)] ?? null,
    }),
    getPhaseState: () => ({
      projectId: inputs.projectId,
      sceneTimeIndex: inputs.sceneTimeIndex,
      resolutionMode: inputs.resolutionMode,
    }),
    getProjectEpoch: () => 0,
    codex: {
      listPhases: (ids) => readCodexPhases(db, ids),
      listPhaseDetailOverrides: (ids) => readCodexPhaseDetailOverrides(db, ids),
      listRawDetailValues: (ids) => readCodexDetailValues(db, ids),
    },
    countTokens: (text) => text.length,
    extractPlainText,
  };
  return { ctx, sent, treeReads: () => treeReads };
}

describe("get_codex_entry の共有 core", () => {
  it("空 id を先に返し、project が無ければ読み出し前に専用エラーにする", async () => {
    const empty = harness({ projectId: "" });
    await expect(getCodexEntry(empty.ctx, { id: "  " })).resolves.toMatchObject(
      {
        summary: "No id provided",
        content: null,
        tokensUsed: 0,
      },
    );
    expect(empty.sent).toEqual([]);
    expect(empty.treeReads()).toBe(0);

    await expect(
      getCodexEntry(empty.ctx, { id: "e-public" }),
    ).rejects.toBeInstanceOf(CoreProjectRequiredError);
    expect(empty.sent).toEqual([]);
  });

  it("Q-C6-1 を直し、自 project の詳細だけを公開項目に含める", async () => {
    const h = harness();
    const result = await getCodexEntry(h.ctx, { id: " e-public " });
    expect(result).toMatchObject({
      name: "get_codex_entry",
      summary: "親 (character)",
      content: {
        id: "e-public",
        name: "親",
        type: "character",
        aliases: ["別名"],
        summary: "公開要約",
        body: "公開本文",
        details: [
          { field: "年齢", value: "18" },
        ],
        children: [],
      },
    });
    expect(result.content?.details).not.toContainEqual({
      field: "別 project の項目名",
      value: null,
    });
    expect(Object.keys(result.content as object)).toEqual([
      "id",
      "name",
      "type",
      "aliases",
      "summary",
      "body",
      "details",
      "children",
    ]);
    expect(result.tokensUsed).toBe(JSON.stringify(result.content).length);
    expect(
      h.sent.map((call) => call.sql.match(/from "([^"]+)"/u)?.[1]),
    ).toEqual([
      "codex_entries",
      "codex_entries",
      "codex_entry_phases",
      "codex_detail_definitions",
      "codex_detail_values",
      "codex_entries",
      "codex_entries",
      "codex_entry_phases",
    ]);
  });

  it("released の本文と詳細だけを使い、hidden・missing は詳細表を読まない", async () => {
    const released = harness();
    const result = await getCodexEntry(released.ctx, { id: "e-release" });
    expect(result.content).toMatchObject({
      summary: "解除後の要約",
      body: "SECRET-PHASE-OLD",
      details: [{ field: "年齢", value: "Phase 解決後の年齢" }],
    });
    expect(result.content?.details).not.toContainEqual({
      field: "別 project の項目名",
      value: null,
    });
    expect(JSON.stringify(result.content)).not.toContain("SECRET-BASE");
    expect(
      released.sent.map((call) => call.sql.match(/from "([^"]+)"/u)?.[1]),
    ).toEqual([
      "codex_entries",
      "codex_entries",
      "codex_entry_phases",
      "codex_phase_detail_overrides",
      "codex_detail_values",
      "codex_detail_definitions",
      "codex_detail_values",
      "codex_entries",
    ]);

    const hidden = harness();
    await expect(
      getCodexEntry(hidden.ctx, { id: "e-hidden" }),
    ).resolves.toMatchObject({
      content: null,
      summary: "Entry not found",
      tokensUsed: 0,
    });
    expect(
      hidden.sent.map((call) => call.sql.match(/from "([^"]+)"/u)?.[1]),
    ).toEqual(["codex_entries", "codex_entries", "codex_entry_phases"]);
    const missing = harness();
    await getCodexEntry(missing.ctx, { id: "missing" });
    expect(missing.sent).toHaveLength(1);
  });

  it("子の判定で場面をもう一度読み、遅れて hidden になった子を落とす", async () => {
    const h = harness({ scenes: [null, "n-s1", "n-s2"] });
    const result = await getCodexEntry(h.ctx, { id: "e-public" });
    expect(h.treeReads()).toBe(3);
    expect((result.content as { children: unknown[] }).children).toEqual([]);
  });
});

describe("assembleCodexEntry の fail-closed", () => {
  const entry = { id: "e", name: "項目", type: "character", aliases: null };
  const ctx = { countTokens: (text: string) => text.length, extractPlainText };

  it("判定 text が無ければ not-found を返す", () => {
    expect(assembleCodexEntry(entry, undefined, [], [], [], ctx)).toMatchObject(
      {
        content: null,
        summary: "Entry not found",
        tokensUsed: 0,
      },
    );
  });

  it("released の詳細 map が無ければ base 値へ fallback せず throw する", () => {
    expect(() =>
      assembleCodexEntry(
        entry,
        { summary: "公開文", content: "{}", released: true, mode: "mentioned" },
        [{ id: "d", name: "詳細", includeInContext: 1 }],
        [{ definitionId: "d", value: "SECRET-BASE-DETAIL" }],
        [],
        ctx,
      ),
    ).toThrow("released Codex entry is missing resolved detail values");
  });
});
