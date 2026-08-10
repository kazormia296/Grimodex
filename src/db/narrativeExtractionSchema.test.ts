import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import {
  narrativeApplyCommits,
  narrativeApplyOperations,
  narrativeCommitJournals,
  narrativeExtractionArtifacts,
  narrativeExtractionAttempts,
  narrativeExtractionRuns,
  narrativeExtractionTaskEdges,
  narrativeExtractionTasks,
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

  it("includes narrative extraction tables in the generated schema contract", () => {
    expect(contractJson.schemaVersion).toBeGreaterThanOrEqual(6);
    for (const tableName of CONTRACT_TABLES) {
      expect(
        contractJson.tables,
        `generate:db-contract must emit ${tableName}`,
      ).toHaveProperty(tableName);
    }
  });
});
