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
  sourceConnectionEpoch: string | null;
  sourceTotalChanges: string | null;
  sourceDataVersion: string | null;
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
  "sourceConnectionEpoch",
  "sourceTotalChanges",
  "sourceDataVersion",
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
      kind: "sqlite_revision_v1",
      expected_connection_epoch: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      expected_total_changes: expect.stringMatching(/^\d+$/),
      expected_data_version: expect.stringMatching(/^\d+$/),
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
          sourceConnectionEpoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
          sourceTotalChanges: "42",
          sourceDataVersion: "7",
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
    expect(args.sql).toContain("total_changes()");
    expect(args.sql).toContain("pragma_data_version");
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
        kind: "sqlite_revision_v1",
        expected_connection_epoch: "5c469be0-51e3-4f31-95e0-9bf457806c56",
        expected_total_changes: "42",
        expected_data_version: "7",
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
