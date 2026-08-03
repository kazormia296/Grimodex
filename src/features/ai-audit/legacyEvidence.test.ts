import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock } from "@/lib/browser-mock";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  LEGACY_EVIDENCE_SOURCE_TABLES,
  loadLegacyEvidence,
  type LegacyEvidenceQuerySource,
  type LegacyEvidenceScopedRow,
  type LegacyEvidenceSourceTable,
} from "./legacyEvidence";

function querySource(
  rowsByTable: Partial<
    Record<LegacyEvidenceSourceTable, readonly LegacyEvidenceScopedRow[]>
  > = {},
): LegacyEvidenceQuerySource {
  return {
    readTable: vi.fn(
      async (sourceTable: LegacyEvidenceSourceTable) =>
        rowsByTable[sourceTable] ?? [],
    ),
  };
}

function artifactRows(jsonl: string): Record<string, unknown>[] {
  return jsonl
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("legacy AI evidence collection", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ rows: [] });
  });

  it("uses project-parameterized Drizzle queries and strict ownership joins for every production source", async () => {
    await loadLegacyEvidence("project-1", {
      assertWorkspaceUnchanged: () => undefined,
    });

    expect(invokeMock).toHaveBeenCalledTimes(
      LEGACY_EVIDENCE_SOURCE_TABLES.length,
    );
    const requests = invokeMock.mock.calls.map((call) => {
      expect(call[0]).toBe("db_execute");
      return call[1] as {
        sql: string;
        params: unknown[];
        method: string;
      };
    });
    expect(
      requests.every((request) => request.params.includes("project-1")),
    ).toBe(true);
    const sql = requests.map((request) => request.sql).join("\n");
    expect(sql).toContain("chat_runtime_threads");
    expect(sql).toContain('inner join "chat_sessions"');
    expect(sql).toContain("legacy_summary_session");
    expect(sql).toContain("legacy_message_session");
    expect(sql).toContain("legacy_relation_annotation_a");
    expect(sql).toContain("legacy_relation_annotation_b");
    expect(sql).toContain('inner join "post_effect_runs"');
    expect(sql).toContain('inner join "map_boards"');
    expect(sql).toContain('from "foreshadow_setups"');
    expect(sql).toContain('inner join "foreshadows"');
    expect(sql).toContain('"foreshadow_setups"."ai_reasoning" is not null');
    expect(sql).toContain('from "prose_staging"');
    expect(sql).toContain('from "change_events"');
    expect(sql).toContain('from "undo_journal"');
    expect(sql).toContain('"undo_journal"."surface" = ?');
    expect(sql).toContain('from "authorship_spans"');
    expect(sql).toContain('left join "codex_detail_values"');
    expect(sql).toContain(
      'left join "codex_entries" "legacy_authorship_detail_codex"',
    );
    expect(sql).toContain('left join "codex_entry_phases"');
    expect(sql).toContain('from "tree_nodes"');
    expect(sql).toContain('from "codex_entries"');
    expect(sql).toContain('from "codex_detail_values"');
    expect(sql).toContain('from "codex_entry_phases"');
    expect(sql).toContain('from "snippets"');
    expect(sql).toContain('from "scene_chunks"');
    expect(sql).toContain('from "codex_chunks"');
    expect(sql).toContain('from "event_chunks"');
    expect(sql).toContain('inner join "events"');
    expect(sql).toContain('from "chat_message_chunks"');
    expect(sql).toContain(
      '"chat_message_chunks"."session_id" = "chat_messages"."session_id"',
    );
    expect(sql).toContain(
      '"chat_message_chunks"."project_id" = "chat_sessions"."project_id"',
    );
    expect(sql).toContain('from "trash_items"');
  });

  it("exports every declared legacy artifact from an empty BrowserMock database", async () => {
    const browser = await createBrowserMock();
    invokeMock.mockImplementation((command, args) =>
      browser.invoke(command as string, args as Record<string, unknown>),
    );

    try {
      const evidence = await loadLegacyEvidence("web-project", {
        assertWorkspaceUnchanged: () => undefined,
      });

      expect(evidence.totalRowCount).toBe(0);
      expect(
        evidence.artifacts.map((artifact) => artifact.sourceTable),
      ).toEqual(LEGACY_EVIDENCE_SOURCE_TABLES);
      expect(evidence.artifacts).toHaveLength(
        LEGACY_EVIDENCE_SOURCE_TABLES.length,
      );
      expect(
        evidence.artifacts.every(
          (artifact) => artifact.rowCount === 0 && artifact.jsonl === "",
        ),
      ).toBe(true);
    } finally {
      browser.close();
    }
  });

  it("declares the selected surviving legacy evidence source set explicitly", () => {
    expect(LEGACY_EVIDENCE_SOURCE_TABLES).toEqual([
      "chat_sessions",
      "chat_runtime_threads",
      "chat_messages",
      "chat_message_prompts",
      "chat_summaries",
      "chat_summary_messages",
      "generation_logs",
      "ai_usage",
      "ab_comparisons",
      "ab_comparison_runs",
      "post_effect_runs",
      "post_effect_annotations",
      "post_effect_annotation_relations",
      "scene_lens_data",
      "map_ai_branches",
      "authorship_spans",
      "tree_nodes",
      "codex_entries",
      "codex_detail_values",
      "codex_entry_phases",
      "snippets",
      "map_stickies",
      "foreshadow_setups",
      "prose_staging",
      "change_events",
      "undo_journal",
      "scene_chunks",
      "codex_chunks",
      "event_chunks",
      "chat_message_chunks",
      "trash_items",
    ]);
  });

  it("lists every required source, emits deterministic JSONL, and declares a non-atomic snapshot", async () => {
    const source = querySource(
      Object.fromEntries(
        LEGACY_EVIDENCE_SOURCE_TABLES.map((table) => {
          const qualifyingRow = (suffix: "a" | "z") => {
            const id = `${table}-${suffix}`;
            const ordered = suffix === "a" ? { id, a: 2 } : { z: 1, id };
            if (table === "authorship_spans") {
              return { ...ordered, source: "ai", nodeId: `node-${suffix}` };
            }
            if (table === "tree_nodes") {
              return {
                ...ordered,
                content: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "text",
                      text: suffix,
                      marks: [{ type: "authorship", attrs: { source: "ai" } }],
                    },
                  ],
                }),
              };
            }
            if (table === "codex_entries") {
              return {
                ...ordered,
                content: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "text",
                      text: suffix,
                      marks: [{ type: "authorship", attrs: { source: "ai" } }],
                    },
                  ],
                }),
              };
            }
            if (table === "codex_detail_values") {
              return {
                ...ordered,
                value: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "text",
                      text: suffix,
                      marks: [{ type: "authorship", attrs: { source: "ai" } }],
                    },
                  ],
                }),
              };
            }
            if (table === "codex_entry_phases") {
              return {
                ...ordered,
                contentOverride: JSON.stringify({
                  type: "doc",
                  content: [
                    {
                      type: "text",
                      text: suffix,
                      marks: [{ type: "authorship", attrs: { source: "ai" } }],
                    },
                  ],
                }),
              };
            }
            if (table === "snippets") {
              return { ...ordered, contentSource: "ai" };
            }
            if (table === "map_stickies") {
              return { ...ordered, aiDerived: 1 };
            }
            if (table === "undo_journal") {
              return { ...ordered, surface: "mcp" };
            }
            if (table === "trash_items") {
              return {
                ...ordered,
                kind: "text-fragment",
                subKind: "text-fragment",
                payload: JSON.stringify({
                  text: suffix,
                  spans: [{ text: suffix, source: "ai" }],
                }),
              };
            }
            return ordered;
          };
          return [
            table,
            [
              {
                scopeProjectId: "project-1",
                row: qualifyingRow("z"),
              },
              {
                scopeProjectId: "project-1",
                row: qualifyingRow("a"),
              },
            ],
          ];
        }),
      ) as unknown as Record<
        LegacyEvidenceSourceTable,
        LegacyEvidenceScopedRow[]
      >,
    );
    const assertWorkspaceUnchanged = vi.fn();

    const first = await loadLegacyEvidence("project-1", {
      querySource: source,
      assertWorkspaceUnchanged,
    });
    const second = await loadLegacyEvidence("project-1", {
      querySource: source,
      assertWorkspaceUnchanged,
    });

    expect(first.artifacts.map((artifact) => artifact.sourceTable)).toEqual(
      LEGACY_EVIDENCE_SOURCE_TABLES,
    );
    expect(first.artifacts.map((artifact) => artifact.file)).toEqual(
      LEGACY_EVIDENCE_SOURCE_TABLES.map(
        (table) => `legacy-evidence/${table}.jsonl`,
      ),
    );
    expect(first.totalRowCount).toBe(LEGACY_EVIDENCE_SOURCE_TABLES.length * 2);
    expect(first.snapshot).toMatchObject({
      atomic: false,
      consistency: "guarded-sequential-queries",
    });
    expect(first).toEqual(second);
    expect(first.artifacts[0]?.jsonl).toBe(
      `${JSON.stringify({ a: 2, id: "chat_sessions-a" })}\n${JSON.stringify({ id: "chat_sessions-z", z: 1 })}\n`,
    );
    expect(assertWorkspaceUnchanged).toHaveBeenCalledTimes(
      LEGACY_EVIDENCE_SOURCE_TABLES.length * 4,
    );
  });

  it("exports only structurally supported AI-attributed owners and never treats a user message link as AI", async () => {
    const aiPm = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "AI",
              marks: [{ type: "authorship", attrs: { source: "ai" } }],
            },
          ],
        },
      ],
    });
    const humanPm = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "text",
          text: "Human",
          marks: [{ type: "authorship", attrs: { source: "human" } }],
        },
      ],
    });
    const scoped = (row: Record<string, unknown>): LegacyEvidenceScopedRow => ({
      scopeProjectId: "project-1",
      row,
    });
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource({
        chat_messages: [
          scoped({ id: "assistant-message", role: "assistant" }),
          scoped({ id: "user-message", role: "user" }),
        ],
        map_ai_branches: [scoped({ id: "branch-1", boardId: "board-1" })],
        authorship_spans: [
          scoped({ id: "span-node", nodeId: "node-span", source: "ai" }),
          scoped({
            id: "span-codex",
            codexEntryId: "codex-span",
            source: "ai",
          }),
          scoped({
            id: "span-detail",
            detailValueId: "detail-span",
            source: "ai",
          }),
          scoped({
            id: "span-phase",
            codexEntryId: "codex-phase-owner",
            phaseId: "phase-span",
            source: "ai",
          }),
          scoped({
            id: "span-snippet",
            snippetId: "snippet-span",
            source: "ai",
          }),
          scoped({
            id: "span-sticky",
            stickyId: "sticky-span",
            source: "ai",
          }),
          scoped({ id: "span-human", nodeId: "node-human", source: "human" }),
        ],
        tree_nodes: [
          scoped({ id: "node-span", nodeType: "scene", content: humanPm }),
          scoped({
            id: "node-pm-note",
            nodeType: "note",
            archivedAt: "2026-08-01T00:00:00Z",
            content: aiPm,
          }),
          scoped({ id: "node-human", nodeType: "scene", content: humanPm }),
        ],
        codex_entries: [
          scoped({ id: "codex-span", content: humanPm }),
          scoped({
            id: "codex-assistant",
            sourceChatMessageId: "assistant-message",
            content: humanPm,
          }),
          scoped({
            id: "codex-user",
            sourceChatMessageId: "user-message",
            content: humanPm,
          }),
          scoped({ id: "codex-pm", content: aiPm }),
          scoped({ id: "codex-phase-owner", content: humanPm }),
        ],
        codex_detail_values: [
          scoped({ id: "detail-span", value: humanPm }),
          scoped({ id: "detail-pm", value: aiPm }),
          scoped({ id: "detail-human", value: humanPm }),
        ],
        codex_entry_phases: [
          scoped({ id: "phase-span", contentOverride: humanPm }),
          scoped({ id: "phase-pm", contentOverride: aiPm }),
          scoped({ id: "phase-human", contentOverride: humanPm }),
        ],
        snippets: [
          scoped({ id: "snippet-span", content: humanPm }),
          scoped({
            id: "snippet-source",
            contentSource: "ai",
            content: humanPm,
          }),
          scoped({
            id: "snippet-assistant",
            sourceChatMessageId: "assistant-message",
            content: humanPm,
          }),
          scoped({
            id: "snippet-user",
            sourceChatMessageId: "user-message",
            content: humanPm,
          }),
          scoped({ id: "snippet-pm", content: aiPm }),
        ],
        map_stickies: [
          scoped({ id: "sticky-span", boardId: "board-1", body: humanPm }),
          scoped({
            id: "sticky-branch",
            boardId: "board-1",
            aiBranchId: "branch-1",
            body: humanPm,
          }),
          scoped({
            id: "sticky-assistant",
            boardId: "board-1",
            sourceChatMessageId: "assistant-message",
            body: humanPm,
          }),
          scoped({
            id: "sticky-user",
            boardId: "board-1",
            sourceChatMessageId: "user-message",
            body: humanPm,
          }),
          scoped({ id: "sticky-pm", boardId: "board-1", body: aiPm }),
          scoped({ id: "sticky-derived", boardId: "board-1", aiDerived: 1 }),
        ],
      }),
      assertWorkspaceUnchanged: () => undefined,
    });
    const rows = (sourceTable: LegacyEvidenceSourceTable) =>
      artifactRows(
        collection.artifacts.find(
          (artifact) => artifact.sourceTable === sourceTable,
        )!.jsonl,
      );
    const ids = (sourceTable: LegacyEvidenceSourceTable) =>
      rows(sourceTable)
        .map((row) => row.id)
        .sort();

    expect(rows("authorship_spans")).toHaveLength(6);
    expect(ids("tree_nodes")).toEqual(["node-pm-note", "node-span"]);
    expect(ids("codex_entries")).toEqual([
      "codex-assistant",
      "codex-pm",
      "codex-span",
    ]);
    expect(ids("codex_detail_values")).toEqual(["detail-pm", "detail-span"]);
    expect(ids("codex_entry_phases")).toEqual(["phase-pm", "phase-span"]);
    expect(ids("snippets")).toEqual([
      "snippet-assistant",
      "snippet-pm",
      "snippet-source",
      "snippet-span",
    ]);
    expect(ids("map_stickies")).toEqual([
      "sticky-assistant",
      "sticky-branch",
      "sticky-derived",
      "sticky-pm",
      "sticky-span",
    ]);
    expect(ids("codex_entries")).not.toContain("codex-phase-owner");
    expect(ids("codex_entries")).not.toContain("codex-user");
    expect(ids("snippets")).not.toContain("snippet-user");
    expect(ids("map_stickies")).not.toContain("sticky-user");
  });

  it("limits undo evidence to successful tracked-write surfaces and labels its observation boundary", async () => {
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource({
        undo_journal: [
          {
            scopeProjectId: "project-1",
            row: { id: "agent", surface: "in-app-agent", afterJson: "{}" },
          },
          {
            scopeProjectId: "project-1",
            row: { id: "mcp", surface: "mcp", beforeJson: "{}" },
          },
          {
            scopeProjectId: "project-1",
            row: { id: "manual", surface: "manual" },
          },
        ],
      }),
      assertWorkspaceUnchanged: () => undefined,
    });
    const artifact = collection.artifacts.find(
      (candidate) => candidate.sourceTable === "undo_journal",
    )!;

    expect(
      artifactRows(artifact.jsonl)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["agent", "mcp"]);
    expect(artifact.limitations).toEqual(
      expect.arrayContaining([
        "successful-tool-mutation-before-and-after-snapshots-not-model-dispatch-or-provider-receipt",
        "mcp-surface-proves-an-external-tool-invocation-not-the-external-client-prompt",
        "rows-may-be-pruned-by-workspace-compaction",
      ]),
    );
  });

  it("exports stored semantic source text and index metadata without claiming realized model input or vectors", async () => {
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource({
        scene_chunks: [
          {
            scopeProjectId: "project-1",
            row: {
              id: "scene-chunk",
              text: "scene model input",
              embedding: { unsafeProxyBlob: true },
              embeddingDim: 256,
              modelId: "model-1",
              contentHash: "content-hash",
              chunkerVersion: "chunker-1",
              createdAt: new Date("2026-08-03T00:00:00.000Z"),
            },
          },
        ],
      }),
      assertWorkspaceUnchanged: () => undefined,
    });
    const artifact = collection.artifacts.find(
      (candidate) => candidate.sourceTable === "scene_chunks",
    )!;
    const row = artifactRows(artifact.jsonl)[0];

    expect(row).toMatchObject({
      text: "scene model input",
      embeddingDim: 256,
      modelId: "model-1",
      contentHash: "content-hash",
      chunkerVersion: "chunker-1",
      createdAt: 1_785_715_200_000,
    });
    expect(row).not.toHaveProperty("embedding");
    expect(artifact).toMatchObject({
      captureClass: "partial",
      limitations: expect.arrayContaining([
        "document-prefix-tokenizer-special-tokens-and-truncated-realized-model-input-not-persisted-or-recoverable",
        "raw-embedding-vector-and-sha-unavailable",
      ]),
    });
  });

  it("includes only structurally confirmed AI trash and counts malformed JSON exclusions", async () => {
    const aiPm = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "text",
          text: "AI",
          marks: [{ type: "authorship", attrs: { source: "ai" } }],
        },
      ],
    });
    const scoped = (row: Record<string, unknown>): LegacyEvidenceScopedRow => ({
      scopeProjectId: "project-1",
      row,
    });
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource({
        trash_items: [
          scoped({
            id: "fragment-ai",
            kind: "text-fragment",
            subKind: "text-fragment",
            payload: JSON.stringify({
              text: "AI",
              spans: [{ text: "AI", source: "ai" }],
            }),
          }),
          scoped({
            id: "fragment-human",
            kind: "text-fragment",
            subKind: "text-fragment",
            payload: JSON.stringify({
              text: "human",
              spans: [{ text: "human", source: "human" }],
            }),
          }),
          scoped({
            id: "snippet-ai",
            kind: "structure-item",
            subKind: "snippet",
            payload: JSON.stringify({ contentSource: "ai", body: "not-json" }),
          }),
          scoped({
            id: "scene-ai",
            kind: "structure-item",
            subKind: "scene",
            payload: JSON.stringify({ body: aiPm }),
          }),
          scoped({
            id: "map-ai",
            kind: "structure-item",
            subKind: "map-sticky",
            payload: JSON.stringify({ body: aiPm }),
          }),
          scoped({
            id: "scene-malformed-body",
            kind: "structure-item",
            subKind: "scene",
            payload: JSON.stringify({ body: "not-json" }),
          }),
          scoped({
            id: "malformed-payload",
            kind: "structure-item",
            subKind: "codex-entry",
            payload: "{broken",
          }),
        ],
      }),
      assertWorkspaceUnchanged: () => undefined,
    });
    const artifact = collection.artifacts.find(
      (candidate) => candidate.sourceTable === "trash_items",
    )!;

    expect(
      artifactRows(artifact.jsonl)
        .map((row) => row.id)
        .sort(),
    ).toEqual(["fragment-ai", "map-ai", "scene-ai", "snippet-ai"]);
    expect(artifact.diagnostics).toEqual({
      examinedRowCount: 7,
      excludedNonAiRowCount: 1,
      malformedJsonExcludedRowCount: 2,
    });
    expect(artifact.limitations).toEqual(
      expect.arrayContaining([
        "malformed-json-rows-are-excluded-as-ai-origin-unclassifiable-and-counted",
        "trash-may-be-pruned-after-60-days-cleared-or-never-captured",
        "short-text-fragments-may-never-have-been-persisted",
      ]),
    );
  });

  it("preserves model-visible content exactly while sanitizing legacy diagnostics", async () => {
    const source = querySource({
      chat_messages: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "message-1",
            content: "The model saw api_key=typed-by-user exactly.",
          },
        },
      ],
      ai_usage: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "usage-1",
            projectId: "project-1",
            metadata: '{"OPENAI_API_KEY":"legacy-secret"}',
          },
        },
      ],
      post_effect_runs: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "run-1",
            projectId: "project-1",
            errorMessage: "Authorization: Bearer legacy-token",
          },
        },
      ],
      ab_comparison_runs: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "ab-run-1",
            projectId: "project-1",
            slots: JSON.stringify([
              {
                slotId: "success",
                ok: true,
                response: "Successful model output with api_key=user-text.",
              },
              {
                slotId: "failed",
                ok: false,
                response: "Authorization: Bearer failed-provider-secret",
              },
            ]),
          },
        },
      ],
      foreshadow_setups: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "setup-1",
            aiReasoning: "The evaluator discussed api_key=fictional exactly.",
            attribution: "ai",
          },
        },
      ],
      prose_staging: [
        {
          scopeProjectId: "project-1",
          row: {
            id: "proposal-1",
            projectId: "project-1",
            status: "rejected",
            proposedContent:
              "Discarded model proposal with Authorization: Bearer fictional-story-token.",
          },
        },
      ],
      change_events: [
        {
          scopeProjectId: "project-1",
          row: {
            eventUid: "change-1",
            projectId: "project-1",
            domain: "prose",
            opType: "agent-proposal",
            payload:
              '{"mixedOrigin":true,"content":"api_key=fictional operational payload"}',
            sequence: 7,
            prevHash: "a".repeat(64),
            hash: "b".repeat(64),
          },
        },
      ],
    });

    const collection = await loadLegacyEvidence("project-1", {
      querySource: source,
      assertWorkspaceUnchanged: () => undefined,
    });
    const byTable = new Map(
      collection.artifacts.map((artifact) => [artifact.sourceTable, artifact]),
    );
    const message = artifactRows(byTable.get("chat_messages")!.jsonl)[0];
    const usage = artifactRows(byTable.get("ai_usage")!.jsonl)[0];
    const run = artifactRows(byTable.get("post_effect_runs")!.jsonl)[0];
    const abRun = artifactRows(byTable.get("ab_comparison_runs")!.jsonl)[0];
    const foreshadowSetup = artifactRows(
      byTable.get("foreshadow_setups")!.jsonl,
    )[0];
    const proseProposal = artifactRows(byTable.get("prose_staging")!.jsonl)[0];
    const changeEvent = artifactRows(byTable.get("change_events")!.jsonl)[0];

    expect(message?.content).toBe(
      "The model saw api_key=typed-by-user exactly.",
    );
    expect(String(usage?.metadata)).not.toContain("legacy-secret");
    expect(String(usage?.metadata)).toContain("[REDACTED:credential]");
    expect(String(run?.errorMessage)).not.toContain("legacy-token");
    expect(String(run?.errorMessage)).toContain("[REDACTED:credential]");
    expect(usage?._legacyEvidence).toMatchObject({
      sanitizedFields: ["metadata"],
    });
    expect(run?._legacyEvidence).toMatchObject({
      sanitizedFields: ["errorMessage"],
    });
    const slots = JSON.parse(String(abRun?.slots)) as Array<{
      ok: boolean;
      response: string;
    }>;
    expect(slots[0]?.response).toBe(
      "Successful model output with api_key=user-text.",
    );
    expect(slots[1]?.response).not.toContain("failed-provider-secret");
    expect(slots[1]?.response).toContain("[REDACTED:credential]");
    expect(abRun?._legacyEvidence).toMatchObject({
      sanitizedFields: ["slots.failed[].response"],
    });
    expect(
      (usage?._legacyEvidence as { redactions: unknown[] }).redactions,
    ).toHaveLength(1);
    expect(byTable.get("ai_usage")).toMatchObject({
      captureClass: "partial",
    });
    expect(byTable.get("post_effect_runs")).toMatchObject({
      captureClass: "partial",
    });
    expect(byTable.get("ab_comparison_runs")).toMatchObject({
      captureClass: "partial",
    });
    expect(foreshadowSetup?.aiReasoning).toBe(
      "The evaluator discussed api_key=fictional exactly.",
    );
    expect(proseProposal?.proposedContent).toBe(
      "Discarded model proposal with Authorization: Bearer fictional-story-token.",
    );
    expect(changeEvent?.payload).toBe(
      '{"mixedOrigin":true,"content":"api_key=fictional operational payload"}',
    );
    expect(byTable.get("foreshadow_setups")).toMatchObject({
      captureClass: "partial",
    });
    expect(byTable.get("prose_staging")).toMatchObject({
      captureClass: "full",
    });
    expect(byTable.get("change_events")).toMatchObject({
      captureClass: "partial",
      limitations: expect.arrayContaining([
        "mixed-human-ai-system-and-external-tool-operational-events",
        "independent-change-events-hash-chain-not-the-forward-ai-audit-chain",
      ]),
    });
  });

  it("fails closed if a query returns a row scoped to another project", async () => {
    const source = querySource({
      chat_messages: [
        {
          scopeProjectId: "project-2",
          row: { id: "cross-project-message" },
        },
      ],
    });

    await expect(
      loadLegacyEvidence("project-1", {
        querySource: source,
        assertWorkspaceUnchanged: () => undefined,
      }),
    ).rejects.toThrow(/chat_messages.*project scope/i);
  });

  it("preserves malformed A/B slot JSON verbatim instead of guessing which text is diagnostic", async () => {
    const malformed =
      "not-json successful model-visible api_key=user-supplied and spacing  ";
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource({
        ab_comparison_runs: [
          {
            scopeProjectId: "project-1",
            row: {
              id: "ab-malformed",
              projectId: "project-1",
              slots: malformed,
            },
          },
        ],
      }),
      assertWorkspaceUnchanged: () => undefined,
    });
    const artifact = collection.artifacts.find(
      (candidate) => candidate.sourceTable === "ab_comparison_runs",
    );
    const row = artifactRows(artifact!.jsonl)[0];

    expect(row?.slots).toBe(malformed);
    expect(row?._legacyEvidence).toBeUndefined();
    expect(collection.credentialPolicy).toMatchObject({
      unclassifiableAbSlotJsonPreservedVerbatim: true,
      classifiedDiagnosticFieldsSanitized: [
        "ai_usage.metadata",
        "post_effect_runs.error_message",
        "ab_comparison_runs.slots.failed[].response",
      ],
    });
    expect(artifact?.limitations).toContain(
      "malformed-or-unclassifiable-slot-json-is-preserved-verbatim-and-cannot-be-classified-for-diagnostic-sanitization",
    );
  });

  it("emits a declared empty artifact for every empty legacy source", async () => {
    const collection = await loadLegacyEvidence("project-1", {
      querySource: querySource(),
      assertWorkspaceUnchanged: () => undefined,
    });

    expect(collection.totalRowCount).toBe(0);
    expect(collection.artifacts).toHaveLength(
      LEGACY_EVIDENCE_SOURCE_TABLES.length,
    );
    for (const artifact of collection.artifacts) {
      expect(artifact.rowCount).toBe(0);
      expect(artifact.jsonl).toBe("");
      expect(artifact.schema).toMatch(
        /^grimodex\/ai-use-legacy-evidence\/.+\/v1$/,
      );
      expect(artifact.limitations.length).toBeGreaterThan(0);
    }
    expect(
      collection.artifacts.find(
        (artifact) => artifact.sourceTable === "trash_items",
      )?.diagnostics,
    ).toEqual({
      examinedRowCount: 0,
      excludedNonAiRowCount: 0,
      malformedJsonExcludedRowCount: 0,
    });
  });

  it("aborts between legacy-table stages if the workspace authority changes", async () => {
    let assertions = 0;
    const source = querySource();

    await expect(
      loadLegacyEvidence("project-1", {
        querySource: source,
        assertWorkspaceUnchanged: () => {
          assertions += 1;
          if (assertions === 4) {
            throw new Error("AI audit workspace changed during export");
          }
        },
      }),
    ).rejects.toThrow("AI audit workspace changed during export");
    expect(source.readTable).toHaveBeenCalledTimes(2);
  });
});
