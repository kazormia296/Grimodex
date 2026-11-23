/**
 * MP-4b 10b commit ① 専用の追加データ。PR-0 の seed には触れず、実 sql.js に後から投入する。
 * `p-main`・`p-other` の同じ `character` slug と、Codex の詳細・Phase の境界を使う。
 */
type SeedValue = string | number | null;
type SeedRow = Readonly<Record<string, SeedValue>>;
interface SeedTable {
  readonly table: string;
  readonly rows: readonly SeedRow[];
}

const T0 = "2026-01-01T00:00:00.000Z";
const document = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });

function entry(
  id: string,
  name: string,
  options: {
    projectId?: string;
    parentId?: string | null;
    summary?: string | null;
    body?: string;
    aliases?: string | null;
    mode?: string;
  } = {},
): SeedRow {
  return {
    id,
    project_id: options.projectId ?? "p-main",
    parent_id: options.parentId ?? null,
    type: "character",
    name,
    aliases: options.aliases ?? null,
    summary: options.summary ?? null,
    content: document(options.body ?? `${name} の本文。`),
    context_mode: options.mode ?? "mentioned",
    created_at: T0,
    updated_at: T0,
  };
}

function definition(
  id: string,
  projectId: string,
  name: string,
  sortOrder: number,
  includeInContext: number,
): SeedRow {
  return {
    id,
    project_id: projectId,
    type_slug: "character",
    name,
    field_type: "text",
    field_config: null,
    sort_order: sortOrder,
    include_in_context: includeInContext,
    version: 0,
    created_at: T0,
    updated_at: T0,
  };
}

function phase(
  id: string,
  entryId: string,
  anchorNodeId: string | null,
  options: {
    summary?: string | null;
    body?: string | null;
    mode?: string | null;
  } = {},
): SeedRow {
  return {
    id,
    entry_id: entryId,
    anchor_node_id: anchorNodeId,
    label: id,
    summary_override: options.summary ?? null,
    content_override:
      options.body === undefined || options.body === null
        ? null
        : document(options.body),
    context_mode_override: options.mode ?? null,
    created_at: T0,
    updated_at: T0,
    version: 0,
  };
}

export const CODEX_ENTRY_SEED: readonly SeedTable[] = [
  {
    table: "codex_entries",
    rows: [
      entry("ge-normal", "通常項目", {
        aliases: '["通常名","別名"]',
        summary: "通常の要約",
        body: "通常の本文",
      }),
      entry("ge-normal-child", "通常の子", {
        parentId: "ge-normal",
        summary: "通常の子要約",
      }),
      entry("ge-hidden-child", "hidden の子", {
        parentId: "ge-normal",
        summary: "SECRET-CHILD",
        mode: "hidden",
      }),
      entry("ge-scene-parent", "場面切替の親", { summary: "親要約" }),
      entry("ge-scene-child", "場面切替の子", {
        parentId: "ge-scene-parent",
        summary: "場面切替前の子要約",
      }),
      entry("ge-released-old", "解除される項目", {
        aliases: null,
        summary: "SECRET-BASE-SUMMARY",
        body: "SECRET-BASE",
        mode: "hidden",
      }),
      entry("ge-release-child", "解除される子", {
        parentId: "ge-released-old",
        summary: "SECRET-BASE-CHILD-SUMMARY",
        mode: "hidden",
      }),
      entry("ge-released-current", "現在の Phase で解除", {
        summary: "SECRET-BASE-CURRENT-SUMMARY",
        body: "SECRET-BASE-CURRENT",
        mode: "hidden",
      }),
      entry("ge-mode", "mode 判定", {
        summary: "SECRET-BASE-MODE-SUMMARY",
        body: "SECRET-BASE-MODE",
        mode: "hidden",
      }),
      entry("ge-base-public-override", "base 公開項目", {
        summary: "公開 base 要約",
        body: "PUBLIC-BASE",
      }),
      entry("ge-no-phase", "Phase なし", {
        summary: "SECRET-BASE-NO-PHASE-SUMMARY",
        body: "SECRET-BASE-NO-PHASE",
        mode: "hidden",
      }),
      entry("ge-hidden", "hidden 項目", {
        summary: "SECRET-BASE-HIDDEN-SUMMARY",
        body: "SECRET-BASE-HIDDEN",
        mode: "hidden",
      }),
      entry("ge-malformed", "壊れた aliases", {
        aliases: "not-json{",
      }),
      entry("ge-alias-object", "非配列 aliases", {
        aliases: '{"alias":"オブジェクト"}',
      }),
      entry("ge-orphan-null", "NULL 起点の hidden Phase", {
        body: "SECRET-BASE-ORPHAN-NULL",
        mode: "hidden",
      }),
      entry("ge-orphan-index", "読む順に無い hidden Phase", {
        body: "SECRET-BASE-ORPHAN-INDEX",
        mode: "hidden",
      }),
      entry("ge-orphan-null-release", "NULL 孤児と解除 Phase", {
        body: "SECRET-BASE-ORPHAN-NULL-RELEASE",
        mode: "hidden",
      }),
      entry("ge-orphan-index-release", "孤児と解除 Phase", {
        body: "SECRET-BASE-ORPHAN-INDEX-RELEASE",
        mode: "hidden",
      }),
      entry("ge-orphan-public", "孤児の公開 Phase だけ", {
        body: "SECRET-BASE-ORPHAN-PUBLIC",
        mode: "hidden",
      }),
      entry("ge-other", "別 project 項目", {
        projectId: "p-other",
        summary: "別 project の要約",
      }),
      entry("ge-race", "判定中に削除する項目", {
        summary: "一回目の select では存在する",
      }),
    ],
  },
  {
    table: "codex_detail_definitions",
    rows: [
      definition("ge-def-age", "p-main", "年齢", 1, 1),
      definition("ge-def-secret", "p-main", "秘密の詳細", 2, 1),
      definition("ge-def-private", "p-main", "AI に含めない詳細", 3, 0),
      definition("ge-def-other", "p-other", "別 project の項目名", 1, 1),
    ],
  },
  {
    table: "codex_detail_values",
    rows: [
      {
        id: "ge-value-normal-age",
        entry_id: "ge-normal",
        definition_id: "ge-def-age",
        value: "18",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "ge-value-normal-private",
        entry_id: "ge-normal",
        definition_id: "ge-def-private",
        value: "PRIVATE-VALUE",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "ge-value-release-age",
        entry_id: "ge-released-old",
        definition_id: "ge-def-age",
        value: "SECRET-BASE-DETAIL",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "ge-value-release-secret",
        entry_id: "ge-released-old",
        definition_id: "ge-def-secret",
        value: "SECRET-BASE-DETAIL-ERASED",
        created_at: T0,
        updated_at: T0,
      },
      {
        id: "ge-value-release-private",
        entry_id: "ge-released-old",
        definition_id: "ge-def-private",
        value: "PRIVATE-BASE-DETAIL",
        created_at: T0,
        updated_at: T0,
      },
    ],
  },
  {
    table: "codex_entry_phases",
    rows: [
      phase("ge-phase-old", "ge-released-old", "n-s1", {
        summary: "SECRET-PHASE-OLD-SUMMARY",
        body: "SECRET-PHASE-OLD",
        mode: "hidden",
      }),
      phase("ge-phase-release", "ge-released-old", "n-s2", {
        summary: "解除後の要約",
        mode: "mentioned",
      }),
      phase("ge-phase-rehide", "ge-released-old", "n-s3", {
        mode: "hidden",
      }),
      phase("ge-phase-release-child", "ge-release-child", "n-s2", {
        summary: "CHILD-PHASE-SUMMARY",
        mode: "mentioned",
      }),
      phase("ge-phase-release-current", "ge-released-current", "n-s2", {
        summary: "SECRET-PHASE-SUMMARY",
        body: "SECRET-PHASE",
        mode: "mentioned",
      }),
      phase("ge-phase-mode-release", "ge-mode", "n-s3", {
        summary: "MODE-PHASE-SUMMARY",
        body: "MODE-PHASE",
        mode: "mentioned",
      }),
      phase("ge-phase-public-override", "ge-base-public-override", "n-s2", {
        summary: "SECRET-PHASE-PUBLIC-SUMMARY",
        body: "SECRET-PHASE-PUBLIC",
      }),
      phase("ge-phase-scene-hide", "ge-scene-child", "n-s2", {
        mode: "hidden",
      }),
      phase("ge-phase-orphan-null", "ge-orphan-null", null, {
        body: "SECRET-PHASE-ORPHAN-NULL",
        mode: "hidden",
      }),
      phase("ge-phase-orphan-index", "ge-orphan-index", "x-s1", {
        body: "SECRET-PHASE-ORPHAN-INDEX",
        mode: "hidden",
      }),
      phase("ge-phase-orphan-null-release", "ge-orphan-null-release", "n-s1", {
        body: "SECRET-PHASE-ORPHAN-NULL-RELEASE",
        mode: "mentioned",
      }),
      phase("ge-phase-orphan-null-hide", "ge-orphan-null-release", null, {
        mode: "hidden",
      }),
      phase(
        "ge-phase-orphan-index-release",
        "ge-orphan-index-release",
        "n-s1",
        { body: "SECRET-PHASE-ORPHAN-INDEX-RELEASE", mode: "mentioned" },
      ),
      phase("ge-phase-orphan-index-hide", "ge-orphan-index-release", "x-s1", {
        mode: "hidden",
      }),
      phase("ge-phase-orphan-public", "ge-orphan-public", null, {
        body: "SECRET-PHASE-ORPHAN-PUBLIC",
        mode: "mentioned",
      }),
    ],
  },
  {
    table: "codex_phase_detail_overrides",
    rows: [
      {
        phase_id: "ge-phase-old",
        definition_id: "ge-def-age",
        value: "SECRET-PHASE-OLD-DETAIL",
      },
      {
        phase_id: "ge-phase-release",
        definition_id: "ge-def-age",
        value: "Phase 解決後の年齢",
      },
      {
        phase_id: "ge-phase-release",
        definition_id: "ge-def-secret",
        value: null,
      },
    ],
  },
];
