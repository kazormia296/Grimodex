import {
  and,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";

import { db } from "@/db/client";
import {
  abComparisonRuns,
  abComparisons,
  aiUsage,
  authorshipSpans,
  chatMessageChunks,
  chatMessagePrompts,
  chatMessages,
  chatRuntimeThreads,
  chatSessions,
  chatSummaries,
  chatSummaryMessages,
  changeEvents,
  codexChunks,
  codexDetailValues,
  codexEntries,
  codexEntryPhases,
  eventChunks,
  events,
  foreshadows,
  foreshadowSetups,
  generationLogs,
  mapAiBranches,
  mapBoards,
  mapStickies,
  postEffectAnnotationRelations,
  postEffectAnnotations,
  postEffectRuns,
  proseStaging,
  sceneChunks,
  sceneLensData,
  snippets,
  trashItems,
  treeNodes,
  undoJournal,
} from "@/db/schema";
import { sanitizeAiAuditDiagnostic } from "./api";
import { compareUnicodeCodePoints } from "./reportCoverage";
import type { AiAuditRedactionRecord } from "./types";

export const LEGACY_EVIDENCE_COLLECTION_SCHEMA =
  "grimodex/ai-use-legacy-evidence-index/v1" as const;

export const LEGACY_EVIDENCE_SOURCE_TABLES = [
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
] as const;

export type LegacyEvidenceSourceTable =
  (typeof LEGACY_EVIDENCE_SOURCE_TABLES)[number];
export type LegacyEvidenceCaptureClass = "full" | "partial";

export interface LegacyEvidenceScopedRow {
  readonly scopeProjectId: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface LegacyEvidenceQuerySource {
  readTable(
    sourceTable: LegacyEvidenceSourceTable,
    projectId: string,
  ): Promise<readonly LegacyEvidenceScopedRow[]>;
}

export interface LegacyEvidenceArtifact {
  readonly file: `legacy-evidence/${LegacyEvidenceSourceTable}.jsonl`;
  readonly sourceTable: LegacyEvidenceSourceTable;
  readonly schema: `grimodex/ai-use-legacy-evidence/${LegacyEvidenceSourceTable}/v1`;
  /** Completeness of the exported source-table row projection, not an execution lifecycle claim. */
  readonly captureClass: LegacyEvidenceCaptureClass;
  readonly rowCount: number;
  readonly limitations: readonly string[];
  readonly diagnostics?: {
    readonly examinedRowCount: number;
    readonly excludedNonAiRowCount: number;
    readonly malformedJsonExcludedRowCount: number;
  };
  readonly jsonl: string;
}

export interface LegacyEvidenceCollection {
  readonly schema: typeof LEGACY_EVIDENCE_COLLECTION_SCHEMA;
  readonly projectId: string;
  readonly snapshot: {
    readonly atomic: false;
    readonly consistency: "guarded-sequential-queries";
    readonly limitations: readonly string[];
  };
  readonly credentialPolicy: {
    readonly modelVisibleContentPreservedVerbatim: true;
    readonly classifiedDiagnosticFieldsSanitized: readonly [
      "ai_usage.metadata",
      "post_effect_runs.error_message",
      "ab_comparison_runs.slots.failed[].response",
    ];
    readonly unclassifiableAbSlotJsonPreservedVerbatim: true;
    readonly modelVisibleContentMayContainUserSuppliedSecrets: true;
    readonly note: string;
  };
  readonly totalRowCount: number;
  readonly artifacts: readonly LegacyEvidenceArtifact[];
}

export interface LoadLegacyEvidenceOptions {
  readonly querySource?: LegacyEvidenceQuerySource;
  readonly assertWorkspaceUnchanged: () => void;
}

interface LegacyEvidenceDescriptor {
  readonly sourceTable: LegacyEvidenceSourceTable;
  readonly captureClass: LegacyEvidenceCaptureClass;
  readonly limitations: readonly string[];
}

const SHARED_LIMITATIONS = [
  "surviving-current-database-rows-only",
  "not-an-execution-lifecycle-ledger",
  "deleted-or-never-recorded-evidence-is-unrecoverable",
  "may-duplicate-forward-ledger-evidence",
] as const;

const LEGACY_EVIDENCE_DESCRIPTORS: readonly LegacyEvidenceDescriptor[] = [
  {
    sourceTable: "chat_sessions",
    captureClass: "full",
    limitations: [...SHARED_LIMITATIONS, "session-metadata-only"],
  },
  {
    sourceTable: "chat_runtime_threads",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "external-runtime-thread-binding-not-external-client-prompt-history",
    ],
  },
  {
    sourceTable: "chat_messages",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "message-rows-do-not-prove-provider-receipt-or-execution-outcome",
    ],
  },
  {
    sourceTable: "chat_message_prompts",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "only-turns-with-a-persisted-prompt-snapshot-are-recoverable",
    ],
  },
  {
    sourceTable: "chat_summaries",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "summary-generation-prompt-and-transport-lifecycle-are-not-stored-here",
    ],
  },
  {
    sourceTable: "chat_summary_messages",
    captureClass: "full",
    limitations: [...SHARED_LIMITATIONS, "summary-source-linkage-only"],
  },
  {
    sourceTable: "generation_logs",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "source-table-does-not-store-generated-output-or-execution-outcome",
    ],
  },
  {
    sourceTable: "ai_usage",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "usage-metadata-diagnostics-are-credential-sanitized",
      "source-table-does-not-store-full-prompts-or-responses",
    ],
  },
  {
    sourceTable: "ab_comparisons",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "comparison-row-does-not-prove-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "ab_comparison_runs",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "failed-slot-response-diagnostics-are-credential-sanitized",
      "malformed-or-unclassifiable-slot-json-is-preserved-verbatim-and-cannot-be-classified-for-diagnostic-sanitization",
      "comparison-row-does-not-prove-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "post_effect_runs",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "error-message-diagnostics-are-credential-sanitized",
      "source-table-does-not-store-the-full-model-visible-prompt",
    ],
  },
  {
    sourceTable: "post_effect_annotations",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "annotation-content-is-preserved-but-its-full-generation-prompt-may-be-absent",
    ],
  },
  {
    sourceTable: "post_effect_annotation_relations",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "relation-evidence-does-not-contain-a-complete-generation-lifecycle",
    ],
  },
  {
    sourceTable: "scene_lens_data",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "lens-result-evidence-does-not-contain-the-full-generation-prompt",
    ],
  },
  {
    sourceTable: "map_ai_branches",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "branch-output-is-represented-only-by-surviving-related-map-rows",
    ],
  },
  {
    sourceTable: "authorship_spans",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "only-source-ai-spans-in-five-canonical-owner-lanes-are-included",
      "phase-id-is-an-orthogonal-codex-owner-refinement",
      "span-evidence-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "tree_nodes",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-surviving-ai-span-or-structured-prosemirror-ai-mark",
      "scene-note-and-archived-node-content-may-be-included",
      "content-may-have-been-human-edited-after-ai-origin",
      "owner-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "codex_entries",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-surviving-ai-span-structured-prosemirror-ai-mark-or-assistant-message-link",
      "user-message-links-are-not-classified-as-ai-origin",
      "content-may-have-been-human-edited-after-ai-origin",
      "owner-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "codex_detail_values",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-surviving-ai-span-or-structured-prosemirror-ai-mark",
      "content-may-have-been-human-edited-after-ai-origin",
      "owner-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "codex_entry_phases",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-phase-linked-ai-span-or-structured-prosemirror-ai-mark",
      "content-may-have-been-human-edited-after-ai-origin",
      "owner-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "snippets",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-surviving-ai-span-content-source-ai-structured-prosemirror-ai-mark-or-assistant-message-link",
      "user-message-links-are-not-classified-as-ai-origin",
      "content-may-have-been-human-edited-after-ai-origin",
      "owner-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
  {
    sourceTable: "map_stickies",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "selected-by-valid-ai-branch-ai-derived-flag-surviving-ai-span-structured-prosemirror-ai-mark-or-assistant-message-link",
      "adopted-ai-stickies-may-no-longer-retain-a-branch-id",
      "user-message-links-are-not-classified-as-ai-origin",
      "content-may-have-been-human-edited-after-ai-origin",
    ],
  },
  {
    sourceTable: "foreshadow_setups",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "only-explicit-ai-assessment-proposal-or-attribution-rows-are-included",
      "ai-fields-do-not-contain-the-exact-generation-prompt-model-route-or-execution-lifecycle",
      "legacy-ai-attribution-does-not-prove-provider-receipt",
    ],
  },
  {
    sourceTable: "prose_staging",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "surviving-proposals-may-be-proposed-accepted-rejected-or-stale",
      "proposal-content-does-not-contain-the-full-prompt-provider-receipt-or-execution-lifecycle",
      "accepted-proposals-may-duplicate-current-body-provenance",
    ],
  },
  {
    sourceTable: "change_events",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "mixed-human-ai-system-and-external-tool-operational-events",
      "payload-semantics-vary-by-domain-and-operation",
      "raw-operational-payload-preserved-verbatim-without-ai-origin-inference",
      "independent-change-events-hash-chain-not-the-forward-ai-audit-chain",
      "hash-fields-exported-but-change-events-chain-not-verified-by-this-bundle",
      "does-not-contain-standalone-mcp-client-system-or-user-prompts",
    ],
  },
  {
    sourceTable: "undo_journal",
    captureClass: "full",
    limitations: [
      ...SHARED_LIMITATIONS,
      "only-in-app-agent-and-mcp-surfaces-are-included",
      "successful-tool-mutation-before-and-after-snapshots-not-model-dispatch-or-provider-receipt",
      "mcp-surface-proves-an-external-tool-invocation-not-the-external-client-prompt",
      "rows-may-be-pruned-by-workspace-compaction",
    ],
  },
  ...(
    [
      "scene_chunks",
      "codex_chunks",
      "event_chunks",
      "chat_message_chunks",
    ] as const
  ).map(
    (sourceTable): LegacyEvidenceDescriptor => ({
      sourceTable,
      captureClass: "partial",
      limitations: [
        ...SHARED_LIMITATIONS,
        "semantic-index-stored-source-text-and-index-metadata-only",
        "document-prefix-tokenizer-special-tokens-and-truncated-realized-model-input-not-persisted-or-recoverable",
        "raw-embedding-vector-and-sha-unavailable",
        "index-row-does-not-prove-model-dispatch-provider-receipt-or-current-owner-content",
      ],
    }),
  ),
  {
    sourceTable: "trash_items",
    captureClass: "partial",
    limitations: [
      ...SHARED_LIMITATIONS,
      "only-structurally-confirmed-ai-attributed-trash-rows-are-included",
      "malformed-json-rows-are-excluded-as-ai-origin-unclassifiable-and-counted",
      "trash-may-be-pruned-after-60-days-cleared-or-never-captured",
      "short-text-fragments-may-never-have-been-persisted",
      "trash-content-may-have-been-human-edited-before-deletion",
      "trash-content-does-not-prove-model-dispatch-or-provider-receipt",
    ],
  },
] as const;

const summarySession = alias(chatSessions, "legacy_summary_session");
const messageSession = alias(chatSessions, "legacy_message_session");
const relationAnnotationA = alias(
  postEffectAnnotations,
  "legacy_relation_annotation_a",
);
const relationAnnotationB = alias(
  postEffectAnnotations,
  "legacy_relation_annotation_b",
);
const authorshipDetailCodex = alias(
  codexEntries,
  "legacy_authorship_detail_codex",
);

function directRows<T extends object>(
  rows: readonly T[],
  getProjectId: (row: T) => string,
): LegacyEvidenceScopedRow[] {
  return rows.map((row) => ({
    scopeProjectId: getProjectId(row),
    row: row as Readonly<Record<string, unknown>>,
  }));
}

function projectedRows(
  rows: readonly (Readonly<Record<string, unknown>> & {
    readonly _scopeProjectId: string;
  })[],
): LegacyEvidenceScopedRow[] {
  return rows.map(({ _scopeProjectId, ...row }) => ({
    scopeProjectId: _scopeProjectId,
    row,
  }));
}

const DRIZZLE_LEGACY_EVIDENCE_QUERY_SOURCE: LegacyEvidenceQuerySource = {
  async readTable(sourceTable, projectId) {
    switch (sourceTable) {
      case "chat_sessions": {
        const rows = await db
          .select()
          .from(chatSessions)
          .where(eq(chatSessions.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "chat_runtime_threads": {
        const rows = await db
          .select({
            ...getTableColumns(chatRuntimeThreads),
            _scopeProjectId: chatSessions.projectId,
          })
          .from(chatRuntimeThreads)
          .innerJoin(
            chatSessions,
            and(
              eq(chatRuntimeThreads.sessionId, chatSessions.id),
              eq(chatRuntimeThreads.projectId, chatSessions.projectId),
            ),
          )
          .where(
            and(
              eq(chatRuntimeThreads.projectId, projectId),
              eq(chatSessions.projectId, projectId),
            ),
          );
        return projectedRows(rows);
      }
      case "chat_messages": {
        const rows = await db
          .select({
            ...getTableColumns(chatMessages),
            _scopeProjectId: chatSessions.projectId,
          })
          .from(chatMessages)
          .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
          .where(eq(chatSessions.projectId, projectId));
        return projectedRows(rows);
      }
      case "chat_message_prompts": {
        const rows = await db
          .select({
            ...getTableColumns(chatMessagePrompts),
            _scopeProjectId: chatSessions.projectId,
          })
          .from(chatMessagePrompts)
          .innerJoin(
            chatMessages,
            eq(chatMessagePrompts.messageId, chatMessages.id),
          )
          .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
          .where(eq(chatSessions.projectId, projectId));
        return projectedRows(rows);
      }
      case "chat_summaries": {
        const rows = await db
          .select({
            ...getTableColumns(chatSummaries),
            _scopeProjectId: chatSessions.projectId,
          })
          .from(chatSummaries)
          .innerJoin(chatSessions, eq(chatSummaries.sessionId, chatSessions.id))
          .where(eq(chatSessions.projectId, projectId));
        return projectedRows(rows);
      }
      case "chat_summary_messages": {
        const rows = await db
          .select({
            ...getTableColumns(chatSummaryMessages),
            _scopeProjectId: summarySession.projectId,
          })
          .from(chatSummaryMessages)
          .innerJoin(
            chatSummaries,
            eq(chatSummaryMessages.summaryId, chatSummaries.id),
          )
          .innerJoin(
            summarySession,
            eq(chatSummaries.sessionId, summarySession.id),
          )
          .innerJoin(
            chatMessages,
            eq(chatSummaryMessages.messageId, chatMessages.id),
          )
          .innerJoin(
            messageSession,
            eq(chatMessages.sessionId, messageSession.id),
          )
          .where(
            and(
              eq(summarySession.projectId, projectId),
              eq(messageSession.projectId, projectId),
            ),
          );
        return projectedRows(rows);
      }
      case "generation_logs": {
        const rows = await db
          .select()
          .from(generationLogs)
          .where(eq(generationLogs.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "ai_usage": {
        const rows = await db
          .select()
          .from(aiUsage)
          .where(eq(aiUsage.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "ab_comparisons": {
        const rows = await db
          .select()
          .from(abComparisons)
          .where(eq(abComparisons.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "ab_comparison_runs": {
        const rows = await db
          .select()
          .from(abComparisonRuns)
          .where(eq(abComparisonRuns.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "post_effect_runs": {
        const rows = await db
          .select()
          .from(postEffectRuns)
          .where(eq(postEffectRuns.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "post_effect_annotations": {
        const rows = await db
          .select({
            ...getTableColumns(postEffectAnnotations),
            _scopeProjectId: postEffectAnnotations.projectId,
          })
          .from(postEffectAnnotations)
          .leftJoin(
            postEffectRuns,
            eq(postEffectAnnotations.runId, postEffectRuns.id),
          )
          .where(
            and(
              eq(postEffectAnnotations.projectId, projectId),
              or(
                isNull(postEffectAnnotations.runId),
                eq(postEffectRuns.projectId, projectId),
              ),
            ),
          );
        return projectedRows(rows);
      }
      case "post_effect_annotation_relations": {
        const rows = await db
          .select({
            ...getTableColumns(postEffectAnnotationRelations),
            _scopeProjectId: postEffectAnnotationRelations.projectId,
          })
          .from(postEffectAnnotationRelations)
          .innerJoin(
            relationAnnotationA,
            eq(
              postEffectAnnotationRelations.annotationAId,
              relationAnnotationA.id,
            ),
          )
          .innerJoin(
            relationAnnotationB,
            eq(
              postEffectAnnotationRelations.annotationBId,
              relationAnnotationB.id,
            ),
          )
          .leftJoin(
            postEffectRuns,
            eq(postEffectAnnotationRelations.runId, postEffectRuns.id),
          )
          .where(
            and(
              eq(postEffectAnnotationRelations.projectId, projectId),
              eq(relationAnnotationA.projectId, projectId),
              eq(relationAnnotationB.projectId, projectId),
              or(
                isNull(postEffectAnnotationRelations.runId),
                eq(postEffectRuns.projectId, projectId),
              ),
            ),
          );
        return projectedRows(rows);
      }
      case "scene_lens_data": {
        const rows = await db
          .select({
            ...getTableColumns(sceneLensData),
            _scopeProjectId: sceneLensData.projectId,
          })
          .from(sceneLensData)
          .innerJoin(postEffectRuns, eq(sceneLensData.runId, postEffectRuns.id))
          .where(
            and(
              eq(sceneLensData.projectId, projectId),
              eq(postEffectRuns.projectId, projectId),
            ),
          );
        return projectedRows(rows);
      }
      case "map_ai_branches": {
        const rows = await db
          .select({
            ...getTableColumns(mapAiBranches),
            _scopeProjectId: mapBoards.projectId,
          })
          .from(mapAiBranches)
          .innerJoin(mapBoards, eq(mapAiBranches.boardId, mapBoards.id))
          .where(eq(mapBoards.projectId, projectId));
        return projectedRows(rows);
      }
      case "authorship_spans": {
        const rows = await db
          .select({
            ...getTableColumns(authorshipSpans),
            _scopeProjectId: sql<string>`coalesce(
              ${treeNodes.projectId},
              ${codexEntries.projectId},
              ${snippets.projectId},
              ${authorshipDetailCodex.projectId},
              ${mapBoards.projectId}
            )`,
          })
          .from(authorshipSpans)
          .leftJoin(treeNodes, eq(authorshipSpans.nodeId, treeNodes.id))
          .leftJoin(
            codexEntries,
            eq(authorshipSpans.codexEntryId, codexEntries.id),
          )
          .leftJoin(
            codexEntryPhases,
            and(
              eq(authorshipSpans.phaseId, codexEntryPhases.id),
              eq(codexEntryPhases.entryId, codexEntries.id),
            ),
          )
          .leftJoin(snippets, eq(authorshipSpans.snippetId, snippets.id))
          .leftJoin(
            codexDetailValues,
            eq(authorshipSpans.detailValueId, codexDetailValues.id),
          )
          .leftJoin(
            authorshipDetailCodex,
            eq(codexDetailValues.entryId, authorshipDetailCodex.id),
          )
          .leftJoin(mapStickies, eq(authorshipSpans.stickyId, mapStickies.id))
          .leftJoin(mapBoards, eq(mapStickies.boardId, mapBoards.id))
          .where(
            and(
              eq(authorshipSpans.source, "ai"),
              or(
                and(
                  isNotNull(authorshipSpans.nodeId),
                  eq(treeNodes.projectId, projectId),
                ),
                and(
                  isNotNull(authorshipSpans.codexEntryId),
                  eq(codexEntries.projectId, projectId),
                  or(
                    isNull(authorshipSpans.phaseId),
                    eq(codexEntryPhases.entryId, codexEntries.id),
                  ),
                ),
                and(
                  isNotNull(authorshipSpans.snippetId),
                  eq(snippets.projectId, projectId),
                ),
                and(
                  isNotNull(authorshipSpans.detailValueId),
                  eq(authorshipDetailCodex.projectId, projectId),
                ),
                and(
                  isNotNull(authorshipSpans.stickyId),
                  eq(mapBoards.projectId, projectId),
                ),
              ),
            ),
          );
        return projectedRows(rows);
      }
      case "tree_nodes": {
        const rows = await db
          .select()
          .from(treeNodes)
          .where(eq(treeNodes.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "codex_entries": {
        const rows = await db
          .select()
          .from(codexEntries)
          .where(eq(codexEntries.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "codex_detail_values": {
        const rows = await db
          .select({
            ...getTableColumns(codexDetailValues),
            _scopeProjectId: codexEntries.projectId,
          })
          .from(codexDetailValues)
          .innerJoin(
            codexEntries,
            eq(codexDetailValues.entryId, codexEntries.id),
          )
          .where(eq(codexEntries.projectId, projectId));
        return projectedRows(rows);
      }
      case "codex_entry_phases": {
        const rows = await db
          .select({
            ...getTableColumns(codexEntryPhases),
            _scopeProjectId: codexEntries.projectId,
          })
          .from(codexEntryPhases)
          .innerJoin(
            codexEntries,
            eq(codexEntryPhases.entryId, codexEntries.id),
          )
          .where(eq(codexEntries.projectId, projectId));
        return projectedRows(rows);
      }
      case "snippets": {
        const rows = await db
          .select()
          .from(snippets)
          .where(eq(snippets.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "map_stickies": {
        const rows = await db
          .select({
            ...getTableColumns(mapStickies),
            _scopeProjectId: mapBoards.projectId,
          })
          .from(mapStickies)
          .innerJoin(mapBoards, eq(mapStickies.boardId, mapBoards.id))
          .where(eq(mapBoards.projectId, projectId));
        return projectedRows(rows);
      }
      case "foreshadow_setups": {
        const rows = await db
          .select({
            ...getTableColumns(foreshadowSetups),
            _scopeProjectId: foreshadows.projectId,
          })
          .from(foreshadowSetups)
          .innerJoin(
            foreshadows,
            eq(foreshadowSetups.foreshadowId, foreshadows.id),
          )
          .where(
            and(
              eq(foreshadows.projectId, projectId),
              or(
                isNotNull(foreshadowSetups.aiStrength),
                isNotNull(foreshadowSetups.aiReasoning),
                isNotNull(foreshadowSetups.aiRationale),
                eq(foreshadowSetups.attribution, "ai"),
              ),
            ),
          );
        return projectedRows(rows);
      }
      case "prose_staging": {
        const rows = await db
          .select()
          .from(proseStaging)
          .where(eq(proseStaging.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "change_events": {
        const rows = await db
          .select()
          .from(changeEvents)
          .where(eq(changeEvents.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
      case "undo_journal": {
        const rows = await db
          .select()
          .from(undoJournal)
          .where(
            and(
              eq(undoJournal.projectId, projectId),
              or(
                eq(undoJournal.surface, "in-app-agent"),
                eq(undoJournal.surface, "mcp"),
              ),
            ),
          );
        return directRows(rows, (row) => row.projectId);
      }
      case "scene_chunks": {
        const rows = await db
          .select({
            id: sceneChunks.id,
            sceneId: sceneChunks.sceneId,
            chunkIndex: sceneChunks.chunkIndex,
            text: sceneChunks.text,
            charStart: sceneChunks.charStart,
            charEnd: sceneChunks.charEnd,
            dialogueRatio: sceneChunks.dialogueRatio,
            embeddingDim: sceneChunks.embeddingDim,
            modelId: sceneChunks.modelId,
            contentHash: sceneChunks.contentHash,
            chunkerVersion: sceneChunks.chunkerVersion,
            createdAt: sceneChunks.createdAt,
            updatedAt: sceneChunks.updatedAt,
            _scopeProjectId: treeNodes.projectId,
          })
          .from(sceneChunks)
          .innerJoin(treeNodes, eq(sceneChunks.sceneId, treeNodes.id))
          .where(eq(treeNodes.projectId, projectId));
        return projectedRows(rows);
      }
      case "codex_chunks": {
        const rows = await db
          .select({
            entryId: codexChunks.entryId,
            entryName: codexChunks.entryName,
            entryType: codexChunks.entryType,
            text: codexChunks.text,
            embeddingDim: codexChunks.embeddingDim,
            modelId: codexChunks.modelId,
            contentHash: codexChunks.contentHash,
            chunkerVersion: codexChunks.chunkerVersion,
            createdAt: codexChunks.createdAt,
            updatedAt: codexChunks.updatedAt,
            _scopeProjectId: codexEntries.projectId,
          })
          .from(codexChunks)
          .innerJoin(codexEntries, eq(codexChunks.entryId, codexEntries.id))
          .where(eq(codexEntries.projectId, projectId));
        return projectedRows(rows);
      }
      case "event_chunks": {
        const rows = await db
          .select({
            eventId: eventChunks.eventId,
            eventTitle: eventChunks.eventTitle,
            eventKind: eventChunks.eventKind,
            text: eventChunks.text,
            embeddingDim: eventChunks.embeddingDim,
            modelId: eventChunks.modelId,
            contentHash: eventChunks.contentHash,
            chunkerVersion: eventChunks.chunkerVersion,
            createdAt: eventChunks.createdAt,
            updatedAt: eventChunks.updatedAt,
            _scopeProjectId: events.projectId,
          })
          .from(eventChunks)
          .innerJoin(events, eq(eventChunks.eventId, events.id))
          .where(eq(events.projectId, projectId));
        return projectedRows(rows);
      }
      case "chat_message_chunks": {
        const rows = await db
          .select({
            messageId: chatMessageChunks.messageId,
            sessionId: chatMessageChunks.sessionId,
            projectId: chatMessageChunks.projectId,
            role: chatMessageChunks.role,
            text: chatMessageChunks.text,
            insertedToEditor: chatMessageChunks.insertedToEditor,
            extractedCount: chatMessageChunks.extractedCount,
            embeddingDim: chatMessageChunks.embeddingDim,
            modelId: chatMessageChunks.modelId,
            contentHash: chatMessageChunks.contentHash,
            chunkerVersion: chatMessageChunks.chunkerVersion,
            createdAt: chatMessageChunks.createdAt,
            updatedAt: chatMessageChunks.updatedAt,
            _scopeProjectId: chatSessions.projectId,
          })
          .from(chatMessageChunks)
          .innerJoin(
            chatMessages,
            and(
              eq(chatMessageChunks.messageId, chatMessages.id),
              eq(chatMessageChunks.sessionId, chatMessages.sessionId),
            ),
          )
          .innerJoin(
            chatSessions,
            and(
              eq(chatMessages.sessionId, chatSessions.id),
              eq(chatMessageChunks.projectId, chatSessions.projectId),
            ),
          )
          .where(eq(chatSessions.projectId, projectId));
        return projectedRows(rows);
      }
      case "trash_items": {
        const rows = await db
          .select()
          .from(trashItems)
          .where(eq(trashItems.projectId, projectId));
        return directRows(rows, (row) => row.projectId);
      }
    }
  },
};

interface LegacyEvidenceSelectionContext {
  readonly assistantMessageIds: Set<string>;
  readonly aiSpanOwnerIds: Readonly<{
    tree_nodes: Set<string>;
    codex_entries: Set<string>;
    codex_detail_values: Set<string>;
    codex_entry_phases: Set<string>;
    snippets: Set<string>;
    map_stickies: Set<string>;
  }>;
  readonly aiBranchBoardById: Map<string, string>;
}

interface EvidenceRowSelection {
  readonly rows: readonly LegacyEvidenceScopedRow[];
  readonly diagnostics?: NonNullable<LegacyEvidenceArtifact["diagnostics"]>;
}

function createSelectionContext(): LegacyEvidenceSelectionContext {
  return {
    assistantMessageIds: new Set(),
    aiSpanOwnerIds: {
      tree_nodes: new Set(),
      codex_entries: new Set(),
      codex_detail_values: new Set(),
      codex_entry_phases: new Set(),
      snippets: new Set(),
      map_stickies: new Set(),
    },
    aiBranchBoardById: new Map(),
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recordSelectionContext(
  sourceTable: LegacyEvidenceSourceTable,
  rows: readonly LegacyEvidenceScopedRow[],
  context: LegacyEvidenceSelectionContext,
): void {
  if (sourceTable === "chat_messages") {
    for (const { row } of rows) {
      const id = nonEmptyString(row.id);
      if (id !== null && row.role === "assistant") {
        context.assistantMessageIds.add(id);
      }
    }
    return;
  }
  if (sourceTable === "map_ai_branches") {
    for (const { row } of rows) {
      const id = nonEmptyString(row.id);
      const boardId = nonEmptyString(row.boardId);
      if (id !== null && boardId !== null) {
        context.aiBranchBoardById.set(id, boardId);
      }
    }
    return;
  }
  if (sourceTable !== "authorship_spans") return;

  for (const { row } of rows) {
    if (row.source !== "ai") continue;
    const nodeId = nonEmptyString(row.nodeId);
    const codexEntryId = nonEmptyString(row.codexEntryId);
    const detailValueId = nonEmptyString(row.detailValueId);
    const snippetId = nonEmptyString(row.snippetId);
    const stickyId = nonEmptyString(row.stickyId);
    const phaseId = nonEmptyString(row.phaseId);
    if (nodeId !== null) context.aiSpanOwnerIds.tree_nodes.add(nodeId);
    if (detailValueId !== null) {
      context.aiSpanOwnerIds.codex_detail_values.add(detailValueId);
    }
    if (snippetId !== null) context.aiSpanOwnerIds.snippets.add(snippetId);
    if (stickyId !== null) context.aiSpanOwnerIds.map_stickies.add(stickyId);
    if (codexEntryId !== null) {
      if (phaseId !== null) {
        context.aiSpanOwnerIds.codex_entry_phases.add(phaseId);
      } else {
        context.aiSpanOwnerIds.codex_entries.add(codexEntryId);
      }
    }
  }
}

interface JsonInspection {
  readonly parsed: unknown;
  readonly malformed: boolean;
}

function parseJsonSafely(value: unknown): JsonInspection {
  if (typeof value !== "string") {
    return { parsed: value, malformed: false };
  }
  try {
    return { parsed: JSON.parse(value) as unknown, malformed: false };
  } catch {
    return { parsed: null, malformed: true };
  }
}

function pmNodeContainsAiMark(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(pmNodeContainsAiMark);
  if (value === null || typeof value !== "object") return false;
  const node = value as Readonly<Record<string, unknown>>;
  if (
    Array.isArray(node.marks) &&
    node.marks.some((candidate) => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        return false;
      }
      const mark = candidate as Readonly<Record<string, unknown>>;
      if (
        mark.type !== "authorship" ||
        mark.attrs === null ||
        typeof mark.attrs !== "object" ||
        Array.isArray(mark.attrs)
      ) {
        return false;
      }
      return (mark.attrs as Readonly<Record<string, unknown>>).source === "ai";
    })
  ) {
    return true;
  }
  return Array.isArray(node.content) && node.content.some(pmNodeContainsAiMark);
}

function inspectPmAiMark(value: unknown): {
  readonly hasAiMark: boolean;
  readonly malformed: boolean;
} {
  if (value === null || value === undefined || value === "") {
    return { hasAiMark: false, malformed: false };
  }
  const inspected = parseJsonSafely(value);
  return {
    hasAiMark: !inspected.malformed && pmNodeContainsAiMark(inspected.parsed),
    malformed: inspected.malformed,
  };
}

function hasAssistantSourceLink(
  row: Readonly<Record<string, unknown>>,
  context: LegacyEvidenceSelectionContext,
): boolean {
  const messageId = nonEmptyString(row.sourceChatMessageId);
  return messageId !== null && context.assistantMessageIds.has(messageId);
}

function ownerRowIsAiAttributed(
  sourceTable:
    | "tree_nodes"
    | "codex_entries"
    | "codex_detail_values"
    | "codex_entry_phases"
    | "snippets"
    | "map_stickies",
  row: Readonly<Record<string, unknown>>,
  context: LegacyEvidenceSelectionContext,
): boolean {
  const id = nonEmptyString(row.id);
  if (id !== null && context.aiSpanOwnerIds[sourceTable].has(id)) return true;

  switch (sourceTable) {
    case "tree_nodes":
      return (
        inspectPmAiMark(row.content).hasAiMark ||
        inspectPmAiMark(row.unplacedBeatsDoc).hasAiMark
      );
    case "codex_entries":
      return (
        inspectPmAiMark(row.content).hasAiMark ||
        inspectPmAiMark(row.notes).hasAiMark ||
        hasAssistantSourceLink(row, context)
      );
    case "codex_detail_values":
      return inspectPmAiMark(row.value).hasAiMark;
    case "codex_entry_phases":
      return inspectPmAiMark(row.contentOverride).hasAiMark;
    case "snippets":
      return (
        row.contentSource === "ai" ||
        inspectPmAiMark(row.content).hasAiMark ||
        hasAssistantSourceLink(row, context)
      );
    case "map_stickies": {
      const branchId = nonEmptyString(row.aiBranchId);
      const boardId = nonEmptyString(row.boardId);
      const validAiBranch =
        branchId !== null &&
        boardId !== null &&
        context.aiBranchBoardById.get(branchId) === boardId;
      return (
        validAiBranch ||
        row.aiDerived === 1 ||
        row.aiDerived === true ||
        inspectPmAiMark(row.body).hasAiMark ||
        hasAssistantSourceLink(row, context)
      );
    }
  }
}

function classifyTrashRow(row: Readonly<Record<string, unknown>>): {
  readonly include: boolean;
  readonly malformed: boolean;
} {
  const payloadInspection = parseJsonSafely(row.payload);
  if (
    payloadInspection.malformed ||
    payloadInspection.parsed === null ||
    typeof payloadInspection.parsed !== "object" ||
    Array.isArray(payloadInspection.parsed)
  ) {
    return { include: false, malformed: payloadInspection.malformed };
  }
  const payload = payloadInspection.parsed as Readonly<Record<string, unknown>>;
  if (row.kind === "text-fragment" || row.subKind === "text-fragment") {
    return {
      include:
        Array.isArray(payload.spans) &&
        payload.spans.some(
          (span) =>
            span !== null &&
            typeof span === "object" &&
            !Array.isArray(span) &&
            (span as Readonly<Record<string, unknown>>).source === "ai",
        ),
      malformed: false,
    };
  }
  if (row.subKind === "snippet" && payload.contentSource === "ai") {
    return { include: true, malformed: false };
  }
  const pmFields =
    row.subKind === "scene"
      ? (["body", "beats"] as const)
      : row.subKind === "codex-entry"
        ? (["body", "notes"] as const)
        : row.subKind === "snippet" || row.subKind === "map-sticky"
          ? (["body"] as const)
          : ([] as const);
  let malformed = false;
  for (const field of pmFields) {
    const inspection = inspectPmAiMark(payload[field]);
    if (inspection.hasAiMark) return { include: true, malformed: false };
    malformed ||= inspection.malformed;
  }
  return { include: false, malformed };
}

function selectEvidenceRows(
  sourceTable: LegacyEvidenceSourceTable,
  rows: readonly LegacyEvidenceScopedRow[],
  context: LegacyEvidenceSelectionContext,
): EvidenceRowSelection {
  if (sourceTable === "authorship_spans") {
    return { rows: rows.filter(({ row }) => row.source === "ai") };
  }
  if (sourceTable === "undo_journal") {
    return {
      rows: rows.filter(
        ({ row }) => row.surface === "in-app-agent" || row.surface === "mcp",
      ),
    };
  }
  if (
    sourceTable === "tree_nodes" ||
    sourceTable === "codex_entries" ||
    sourceTable === "codex_detail_values" ||
    sourceTable === "codex_entry_phases" ||
    sourceTable === "snippets" ||
    sourceTable === "map_stickies"
  ) {
    return {
      rows: rows.filter(({ row }) =>
        ownerRowIsAiAttributed(sourceTable, row, context),
      ),
    };
  }
  if (sourceTable === "trash_items") {
    const selected: LegacyEvidenceScopedRow[] = [];
    let malformedJsonExcludedRowCount = 0;
    let excludedNonAiRowCount = 0;
    for (const scopedRow of rows) {
      const classification = classifyTrashRow(scopedRow.row);
      if (classification.include) {
        selected.push(scopedRow);
      } else if (classification.malformed) {
        malformedJsonExcludedRowCount += 1;
      } else {
        excludedNonAiRowCount += 1;
      }
    }
    return {
      rows: selected,
      diagnostics: {
        examinedRowCount: rows.length,
        excludedNonAiRowCount,
        malformedJsonExcludedRowCount,
      },
    };
  }
  return { rows };
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw new Error("Legacy AI evidence contains an invalid date");
    }
    return timestamp;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Legacy AI evidence contains a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(compareUnicodeCodePoints)
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new Error(
    `Legacy AI evidence contains an unsupported ${typeof value} value`,
  );
}

function diagnosticMetadata(
  field: string,
  redactions: readonly AiAuditRedactionRecord[],
): Record<string, unknown> {
  return {
    sanitizedFields: [field],
    redactions,
  };
}

async function sanitizeAbComparisonRunSlots(
  row: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  if (typeof row.slots !== "string" || row.slots === "") return row;

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.slots) as unknown;
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    return row;
  }

  const slots = parsed.map((slot) =>
    slot !== null && typeof slot === "object" && !Array.isArray(slot)
      ? { ...(slot as Record<string, unknown>) }
      : slot,
  );
  const redactions: AiAuditRedactionRecord[] = [];
  for (const [index, slot] of slots.entries()) {
    if (
      slot === null ||
      typeof slot !== "object" ||
      Array.isArray(slot) ||
      slot.ok !== false ||
      typeof slot.response !== "string"
    ) {
      continue;
    }
    const sanitized = await sanitizeAiAuditDiagnostic(
      slot.response,
      `legacy-evidence.ab_comparison_runs.slots.${index}.response`,
    );
    if (sanitized.redactions.length > 0) {
      slot.response = sanitized.value;
      redactions.push(...sanitized.redactions);
    }
  }
  if (redactions.length === 0) return row;
  return {
    ...row,
    slots: JSON.stringify(slots),
    _legacyEvidence: diagnosticMetadata("slots.failed[].response", redactions),
  };
}

async function sanitizeLegacyDiagnosticFields(
  sourceTable: LegacyEvidenceSourceTable,
  row: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  if (sourceTable === "ab_comparison_runs") {
    return sanitizeAbComparisonRunSlots(row);
  }
  const field =
    sourceTable === "ai_usage"
      ? "metadata"
      : sourceTable === "post_effect_runs"
        ? "errorMessage"
        : null;
  if (field === null || typeof row[field] !== "string" || row[field] === "") {
    return row;
  }

  const sanitized = await sanitizeAiAuditDiagnostic(
    row[field],
    `legacy-evidence.${sourceTable}.${field}`,
  );
  if (sanitized.redactions.length === 0) {
    return row;
  }
  return {
    ...row,
    [field]: sanitized.value,
    _legacyEvidence: diagnosticMetadata(field, sanitized.redactions),
  };
}

const SEMANTIC_LEGACY_TABLES = new Set<LegacyEvidenceSourceTable>([
  "scene_chunks",
  "codex_chunks",
  "event_chunks",
  "chat_message_chunks",
]);

function projectLegacyEvidenceRow(
  sourceTable: LegacyEvidenceSourceTable,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!SEMANTIC_LEGACY_TABLES.has(sourceTable) || !("embedding" in row)) {
    return row;
  }
  const { embedding: _embedding, ...projected } = row;
  return projected;
}

function assertRowsAreProjectScoped(
  sourceTable: LegacyEvidenceSourceTable,
  projectId: string,
  rows: readonly LegacyEvidenceScopedRow[],
): void {
  for (const row of rows) {
    if (row.scopeProjectId !== projectId) {
      throw new Error(
        `Legacy AI evidence ${sourceTable} query violated project scope`,
      );
    }
  }
}

async function buildArtifact(
  descriptor: LegacyEvidenceDescriptor,
  projectId: string,
  rows: readonly LegacyEvidenceScopedRow[],
  diagnostics?: NonNullable<LegacyEvidenceArtifact["diagnostics"]>,
): Promise<LegacyEvidenceArtifact> {
  assertRowsAreProjectScoped(descriptor.sourceTable, projectId, rows);

  const lines = await Promise.all(
    rows.map(async ({ row }) =>
      JSON.stringify(
        canonicalize(
          await sanitizeLegacyDiagnosticFields(
            descriptor.sourceTable,
            projectLegacyEvidenceRow(descriptor.sourceTable, row),
          ),
        ),
      ),
    ),
  );
  lines.sort(compareUnicodeCodePoints);

  return {
    file: `legacy-evidence/${descriptor.sourceTable}.jsonl`,
    sourceTable: descriptor.sourceTable,
    schema: `grimodex/ai-use-legacy-evidence/${descriptor.sourceTable}/v1`,
    captureClass: descriptor.captureClass,
    rowCount: lines.length,
    limitations: descriptor.limitations,
    ...(diagnostics === undefined ? {} : { diagnostics }),
    jsonl: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
  };
}

export function createEmptyLegacyEvidenceCollection(
  projectId: string,
): LegacyEvidenceCollection {
  return {
    schema: LEGACY_EVIDENCE_COLLECTION_SCHEMA,
    projectId,
    snapshot: {
      atomic: false,
      consistency: "guarded-sequential-queries",
      limitations: [
        "source-tables-are-read-sequentially-without-a-multi-table-database-transaction",
        "concurrent-writes-may-produce-cross-table-time-skew",
      ],
    },
    credentialPolicy: {
      modelVisibleContentPreservedVerbatim: true,
      classifiedDiagnosticFieldsSanitized: [
        "ai_usage.metadata",
        "post_effect_runs.error_message",
        "ab_comparison_runs.slots.failed[].response",
      ],
      unclassifiableAbSlotJsonPreservedVerbatim: true,
      modelVisibleContentMayContainUserSuppliedSecrets: true,
      note: "Credential-shaped text in classified diagnostic-only legacy fields is sanitized. Malformed or unclassifiable A/B slot JSON is preserved verbatim with an artifact limitation instead of guessing which bytes are diagnostic. Model-visible prompts, context, messages, annotations, successful outputs, explicit foreshadow AI fields, prose staging proposals, selected AI-attributed owner content, semantic index source text, undo snapshots, and structurally confirmed trash payloads are preserved exactly. change_events payload is preserved as mixed-origin operational evidence without inferring that it is a diagnostic. These exact fields may therefore contain user-supplied secrets.",
    },
    totalRowCount: 0,
    artifacts: LEGACY_EVIDENCE_DESCRIPTORS.map((descriptor) => ({
      file: `legacy-evidence/${descriptor.sourceTable}.jsonl`,
      sourceTable: descriptor.sourceTable,
      schema: `grimodex/ai-use-legacy-evidence/${descriptor.sourceTable}/v1`,
      captureClass: descriptor.captureClass,
      rowCount: 0,
      limitations: descriptor.limitations,
      ...(descriptor.sourceTable === "trash_items"
        ? {
            diagnostics: {
              examinedRowCount: 0,
              excludedNonAiRowCount: 0,
              malformedJsonExcludedRowCount: 0,
            },
          }
        : {}),
      jsonl: "",
    })),
  };
}

export async function loadLegacyEvidence(
  projectId: string,
  options: LoadLegacyEvidenceOptions,
): Promise<LegacyEvidenceCollection> {
  if (projectId.trim() === "") {
    throw new Error("Legacy AI evidence export requires a project ID");
  }
  const querySource =
    options.querySource ?? DRIZZLE_LEGACY_EVIDENCE_QUERY_SOURCE;
  const artifacts: LegacyEvidenceArtifact[] = [];
  const selectionContext = createSelectionContext();

  for (const descriptor of LEGACY_EVIDENCE_DESCRIPTORS) {
    options.assertWorkspaceUnchanged();
    const rows = await querySource.readTable(descriptor.sourceTable, projectId);
    options.assertWorkspaceUnchanged();
    assertRowsAreProjectScoped(descriptor.sourceTable, projectId, rows);
    const selection = selectEvidenceRows(
      descriptor.sourceTable,
      rows,
      selectionContext,
    );
    recordSelectionContext(
      descriptor.sourceTable,
      selection.rows,
      selectionContext,
    );
    artifacts.push(
      await buildArtifact(
        descriptor,
        projectId,
        selection.rows,
        selection.diagnostics,
      ),
    );
  }

  const empty = createEmptyLegacyEvidenceCollection(projectId);
  return {
    ...empty,
    totalRowCount: artifacts.reduce(
      (total, artifact) => total + artifact.rowCount,
      0,
    ),
    artifacts,
  };
}
