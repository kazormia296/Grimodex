import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import {
  narrativeApplyCommits,
  narrativeApplyOperations,
  narrativeCommitJournals,
  narrativeExtractionArtifacts,
  narrativeExtractionAttempts,
  narrativeExtractionStageModelBindings,
  narrativeExtractionStageReceipts,
  narrativeExtractionRuns,
  narrativeExtractionTaskEdges,
  narrativeExtractionTasks,
  narrativeSceneScopeBindings,
  narrativeScopeRegistries,
  narrativeProposalApplications,
  narrativeProposalDecisions,
  narrativeProposalRevisions,
  narrativeProposals,
  narrativeProposalSets,
} from "./schema";

const CONTRACT_TABLES = [
  "narrative_extraction_runs",
  "narrative_extraction_tasks",
  "narrative_extraction_task_edges",
  "narrative_extraction_attempts",
  "narrative_extraction_artifacts",
  "narrative_extraction_stage_model_bindings",
  "narrative_extraction_stage_receipts",
  "narrative_scope_registries",
  "narrative_scene_scope_bindings",
  "narrative_proposal_sets",
  "narrative_proposals",
  "narrative_proposal_revisions",
  "narrative_proposal_decisions",
  "narrative_apply_commits",
  "narrative_apply_operations",
  "narrative_proposal_applications",
  "narrative_commit_journals",
] as const;

describe("narrative extraction schema", () => {
  it("exports Drizzle tables with canonical physical names", () => {
    expect(getTableName(narrativeExtractionRuns)).toBe(
      "narrative_extraction_runs",
    );
    expect(getTableName(narrativeExtractionTasks)).toBe(
      "narrative_extraction_tasks",
    );
    expect(getTableName(narrativeExtractionTaskEdges)).toBe(
      "narrative_extraction_task_edges",
    );
    expect(getTableName(narrativeExtractionAttempts)).toBe(
      "narrative_extraction_attempts",
    );
    expect(getTableName(narrativeExtractionArtifacts)).toBe(
      "narrative_extraction_artifacts",
    );
    expect(getTableName(narrativeExtractionStageModelBindings)).toBe(
      "narrative_extraction_stage_model_bindings",
    );
    expect(getTableName(narrativeExtractionStageReceipts)).toBe(
      "narrative_extraction_stage_receipts",
    );
    expect(getTableName(narrativeScopeRegistries)).toBe(
      "narrative_scope_registries",
    );
    expect(getTableName(narrativeSceneScopeBindings)).toBe(
      "narrative_scene_scope_bindings",
    );
    expect(getTableName(narrativeProposalSets)).toBe("narrative_proposal_sets");
    expect(getTableName(narrativeProposals)).toBe("narrative_proposals");
    expect(getTableName(narrativeProposalRevisions)).toBe(
      "narrative_proposal_revisions",
    );
    expect(getTableName(narrativeProposalDecisions)).toBe(
      "narrative_proposal_decisions",
    );
    expect(getTableName(narrativeApplyCommits)).toBe("narrative_apply_commits");
    expect(getTableName(narrativeApplyOperations)).toBe(
      "narrative_apply_operations",
    );
    expect(getTableName(narrativeProposalApplications)).toBe(
      "narrative_proposal_applications",
    );
    expect(getTableName(narrativeCommitJournals)).toBe(
      "narrative_commit_journals",
    );
  });

  it("keeps the SCHEMA 43 Scene body declaration columns Rust-only nullable TEXT", () => {
    // Rust だけが書く列は renderer の Drizzle に載せない（型付き insert／update
    // から名指しできない）。物理定義は contract にだけ載る。
    const columns = getTableColumns(narrativeSceneScopeBindings);
    expect(Object.keys(columns)).not.toContain("bodyDeclarationJson");
    expect(Object.keys(columns)).not.toContain("bodyDeclarationToken");
    const physicalColumns = Object.values(columns).map((column) => column.name);
    expect(physicalColumns).not.toContain("body_declaration_json");
    expect(physicalColumns).not.toContain("body_declaration_token");
    const contractColumns = contractJson.tables.narrative_scene_scope_bindings
      .columns as Record<
      string,
      { declaredType: string; notNull: boolean; default: string | null }
    >;
    for (const name of ["body_declaration_json", "body_declaration_token"]) {
      expect(contractColumns[name]).toMatchObject({
        declaredType: "TEXT",
        notNull: false,
        default: null,
      });
    }
    // The v1 definition keeps its own columns: the two new ones only follow it.
    expect(contractColumns.source_token.notNull).toBe(true);
    expect(contractColumns.updated_at.notNull).toBe(true);
  });

  it("includes narrative extraction tables in the generated schema contract", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(9);
    for (const tableName of CONTRACT_TABLES) {
      expect(
        contractJson.tables,
        `generate:db-contract must emit ${tableName}`,
      ).toHaveProperty(tableName);
    }
  });
});
