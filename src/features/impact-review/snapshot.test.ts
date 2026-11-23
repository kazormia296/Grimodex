import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

import { buildCodexSnapshot } from "./snapshot";
import { createBrowserMock } from "@/lib/browser-mock";

interface SnapshotProxyRow {
  kind: string;
  projectId: string | null;
  entryType: string | null;
  entryName: string | null;
  aliases: string | null;
  summary: string | null;
  content: string | null;
  contextMode: string | null;
  sourceLineage: string | null;
  sourceSeq: string | null;
  detailId: string | null;
  detailName: string | null;
  detailValue: string | null;
  phaseId: string | null;
  phaseLabel: string | null;
  phaseSummary: string | null;
  phaseContent: string | null;
  phaseContextMode: string | null;
  phaseDetailId: string | null;
  phaseDetailName: string | null;
  phaseDetailValue: string | null;
}

const proxyColumns: Array<keyof SnapshotProxyRow> = [
  "kind",
  "projectId",
  "entryType",
  "entryName",
  "aliases",
  "summary",
  "content",
  "contextMode",
  "sourceLineage",
  "sourceSeq",
  "detailId",
  "detailName",
  "detailValue",
  "phaseId",
  "phaseLabel",
  "phaseSummary",
  "phaseContent",
  "phaseContextMode",
  "phaseDetailId",
  "phaseDetailName",
  "phaseDetailValue",
];

function proxyRow(
  values: Pick<SnapshotProxyRow, "kind"> & Partial<SnapshotProxyRow>,
): Record<string, unknown> {
  return Object.fromEntries(
    proxyColumns.map((column, index) => [
      `column_${index}`,
      values[column] ?? null,
    ]),
  );
}

function proseMirrorDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("buildCodexSnapshot", () => {
  it("runs the atomic snapshot query against the browser mock connection", async () => {
    const browser = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    const now = new Date().toISOString();
    await browser.invoke("db_execute", {
      sql: `INSERT INTO codex_entries
        (id, project_id, type, name, aliases, summary, content,
         context_mode, children_budget, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        "entry-browser",
        "default-project",
        "character",
        "アリス",
        '["アリー"]',
        "主人公。",
        proseMirrorDoc("町に住んでいる。"),
        "mentioned",
        "compact",
        now,
        now,
      ],
      method: "run",
    });
    mockInvoke.mockImplementation(browser.invoke);

    const result = await buildCodexSnapshot("entry-browser");

    expect(result?.projectId).toBe("default-project");
    expect(result?.snapshot.name).toBe("アリス");
    expect(result?.sourceRevision).toEqual({
      kind: "sqlite_write_clock_v1",
      expected_lineage: expect.stringMatching(/^[0-9a-f]{32}$/),
      expected_seq: expect.stringMatching(/^\d+$/),
    });
  });

  it("loads the tagged UNION ALL in one db_execute and aggregates visibility-safe rows", async () => {
    mockInvoke.mockResolvedValue({
      rows: [
        proxyRow({
          kind: "entry",
          projectId: "project-1",
          entryType: "character",
          entryName: "アリス",
          aliases: JSON.stringify(["アリー"]),
          summary: "主人公。",
          content: proseMirrorDoc("町に住んでいる。"),
          contextMode: "mentioned",
          sourceLineage: "5c469be051e34f31a95e0bf457806c56",
          sourceSeq: "42",
        }),
        proxyRow({
          kind: "detail",
          detailId: "detail-age",
          detailName: "年齢",
          detailValue: "15",
        }),
        proxyRow({
          kind: "phase",
          phaseId: "phase-secret",
          phaseLabel: "秘密期",
          phaseSummary: "正体を隠している。",
          phaseContextMode: "hidden",
        }),
        proxyRow({
          kind: "phase",
          phaseId: "phase-later",
          phaseLabel: "後編",
          phaseContent: proseMirrorDoc("騎士団長になる。"),
          phaseContextMode: "always",
        }),
        proxyRow({
          kind: "phase-detail",
          phaseId: "phase-secret",
          phaseDetailId: "detail-role",
          phaseDetailName: "役職",
          phaseDetailValue: "王女",
        }),
      ],
    });

    const result = await buildCodexSnapshot("entry-1");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const [command, args] = mockInvoke.mock.calls[0] as unknown as [
      string,
      { sql: string; params: unknown[]; method: string },
    ];
    expect(command).toBe("db_execute");
    expect(args.method).toBe("all");
    expect(args.sql.match(/\bunion all\b/gi)).toHaveLength(3);
    expect(args.sql).toContain("grimodex_clock_read");
    expect(args.sql).not.toContain("total_changes()");
    expect(args.sql).not.toContain("pragma_data_version");
    expect(args.sql).not.toContain("grimodex_connection_meta");
    expect(args.params).toEqual(
      expect.arrayContaining([
        "entry",
        "detail",
        "phase",
        "phase-detail",
        "entry-1",
      ]),
    );
    expect(result).toEqual({
      projectId: "project-1",
      entryType: "character",
      entryName: "アリス",
      sourceRevision: {
        kind: "sqlite_write_clock_v1",
        expected_lineage: "5c469be051e34f31a95e0bf457806c56",
        expected_seq: "42",
      },
      contextMode: "mentioned",
      hasRestrictedPhases: true,
      snapshot: {
        name: "アリス",
        aliases: ["アリー"],
        summary: "主人公。",
        contentPlain: "町に住んでいる。",
        details: [{ name: "年齢", value: "15" }],
        phases: [
          {
            phaseId: "phase-secret",
            label: "秘密期",
            summary: "正体を隠している。",
            contentPlain: null,
            details: [{ name: "役職", value: "王女" }],
          },
          {
            phaseId: "phase-later",
            label: "後編",
            summary: null,
            contentPlain: "騎士団長になる。",
            details: [],
          },
        ],
        visibilityProvenanceVersion: 1,
        allPhaseIds: ["phase-secret", "phase-later"],
        restrictedPhaseIds: ["phase-secret"],
      },
    });
  });
});

describe("buildCodexSnapshot の制限判定（DR-MP4-44。挙動は変えない）", () => {
  const entryRow = (contextMode: string | null) =>
    proxyRow({
      kind: "entry",
      projectId: "project-1",
      entryType: "character",
      entryName: "アリス",
      aliases: "[]",
      summary: "主人公。",
      content: proseMirrorDoc("町に住んでいる。"),
      contextMode,
      sourceLineage: "5c469be051e34f31a95e0bf457806c56",
      sourceSeq: "42",
    });

  // Phase の contextModeOverride。null は継承なので制限しない。`current-mention`
  // を満たす mentioned・always だけが制限なし。hidden・suppress・不明・空文字は制限する。
  it.each([
    [null, false],
    ["mentioned", false],
    ["always", false],
    ["hidden", true],
    ["suppress", true],
    ["unknown-mode", true],
    ["", true],
  ] as const)(
    "Phase の contextModeOverride=%j → 制限=%s",
    async (phaseContextMode, restricted) => {
      mockInvoke.mockResolvedValue({
        rows: [
          entryRow("mentioned"),
          proxyRow({
            kind: "phase",
            phaseId: "phase-1",
            phaseLabel: "後編",
            phaseSummary: "要約。",
            phaseContextMode,
          }),
        ],
      });

      const result = await buildCodexSnapshot("entry-1");

      expect(result?.hasRestrictedPhases).toBe(restricted);
      expect(result?.snapshot.restrictedPhaseIds).toEqual(
        restricted ? ["phase-1"] : [],
      );
      expect(result?.snapshot.allPhaseIds).toEqual(["phase-1"]);
    },
  );

  it("制限は Phase ごとに数え、1 つでも非公開なら hasRestrictedPhases は真になる", async () => {
    mockInvoke.mockResolvedValue({
      rows: [
        entryRow("mentioned"),
        proxyRow({
          kind: "phase",
          phaseId: "phase-open",
          phaseSummary: "公開。",
          phaseContextMode: "always",
        }),
        proxyRow({
          kind: "phase",
          phaseId: "phase-closed",
          phaseSummary: "非公開。",
          phaseContextMode: "suppress",
        }),
        proxyRow({
          kind: "phase",
          phaseId: "phase-inherit",
          phaseSummary: "継承。",
          phaseContextMode: null,
        }),
      ],
    });

    const result = await buildCodexSnapshot("entry-1");

    expect(result?.hasRestrictedPhases).toBe(true);
    expect(result?.snapshot.restrictedPhaseIds).toEqual(["phase-closed"]);
  });

  it.each(["hidden", "suppress", "unknown-mode", "", "always"])(
    "base の contextMode=%j はそのまま返す（判定は run の門が行う）",
    async (contextMode) => {
      mockInvoke.mockResolvedValue({ rows: [entryRow(contextMode)] });

      const result = await buildCodexSnapshot("entry-1");

      expect(result?.contextMode).toBe(contextMode);
      expect(result?.hasRestrictedPhases).toBe(false);
    },
  );

  it("base の contextMode が null なら snapshot を作らない（null を返す）", async () => {
    mockInvoke.mockResolvedValue({ rows: [entryRow(null)] });

    expect(await buildCodexSnapshot("entry-1")).toBeNull();
  });
});

describe("buildCodexSnapshot の includeInContext の述語（実 sql.js）", () => {
  // canned の行では述語が効くことは固定できない。実 DB に include_in_context が 0 と 1 の
  // 定義を入れ、0 の値は SQL が返さず 1 だけが返ることを、detail と
  // phase-detail のそれぞれで固定する。
  it("include_in_context=0 の detail・phase-detail の値は SQL が返さない", async () => {
    const browser = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    const now = "2026-11-24T00:00:00.000Z";
    const run = (sql: string, params: unknown[]) =>
      browser.invoke("db_execute", { sql, params, method: "run" });
    await run(
      `INSERT INTO codex_entries
        (id, project_id, type, name, aliases, summary, content,
         context_mode, children_budget, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "entry-detail",
        "default-project",
        "character",
        "アリス",
        "[]",
        "主人公。",
        proseMirrorDoc("町に住んでいる。"),
        "mentioned",
        "compact",
        now,
        now,
      ],
    );
    for (const [id, name, include] of [
      ["def-open", "年齢", 1],
      ["def-closed", "作者メモ", 0],
    ] as const) {
      await run(
        `INSERT INTO codex_detail_definitions
          (id, project_id, type_slug, name, field_type, sort_order,
           include_in_context, version, created_at, updated_at)
         VALUES (?, 'default-project', 'character', ?, 'text', 0, ?, 0, ?, ?)`,
        [id, name, include, now, now],
      );
      await run(
        `INSERT INTO codex_detail_values
          (id, entry_id, definition_id, value, version, created_at, updated_at)
         VALUES (?, 'entry-detail', ?, ?, 1, ?, ?)`,
        [`value-${id}`, id, `${name}の値`, now, now],
      );
    }
    await run(
      `INSERT INTO codex_entry_phases
        (id, entry_id, label, summary_override, content_override,
         context_mode_override, version, created_at, updated_at)
       VALUES ('phase-d', 'entry-detail', '後編', NULL, NULL, NULL, 1, ?, ?)`,
      [now, now],
    );
    for (const [id, name] of [
      ["def-open", "年齢"],
      ["def-closed", "作者メモ"],
    ] as const) {
      await run(
        `INSERT INTO codex_phase_detail_overrides
          (phase_id, definition_id, value) VALUES ('phase-d', ?, ?)`,
        [id, `後編の${name}の値`],
      );
    }
    // browser mock は行を列名の object で返し、UNION ALL の重複する列名（name・NULL など）
    // が潰れる。そのため snapshot の中身ではなく、SQL が返した行の種類と数で述語を固定する。
    const unionRows: Array<Record<string, unknown>> = [];
    mockInvoke.mockImplementation(async (command: string, args: unknown) => {
      const result = await browser.invoke<{
        rows: Array<Record<string, unknown>>;
      }>(command, args as never);
      if (command === "db_execute") unionRows.push(...result.rows);
      return result;
    });

    await buildCodexSnapshot("entry-detail");

    // 先頭の列が行の種類。include_in_context=1 の定義だけが detail・phase-detail に 1 行ずつ出る。
    expect(unionRows.map((row) => Object.values(row)[0]).sort()).toEqual([
      "detail",
      "entry",
      "phase",
      "phase-detail",
    ]);
    expect(JSON.stringify(unionRows)).toContain("年齢の値");
    expect(JSON.stringify(unionRows)).toContain("後編の年齢の値");
    expect(JSON.stringify(unionRows)).not.toContain("作者メモ");
  });
});
