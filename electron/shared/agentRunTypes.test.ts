import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_RUN_CAPABILITY_STATES,
  AGENT_RUN_ERROR_CODES,
  AGENT_RUN_EXECUTION_STATES,
  AGENT_RUN_INTERACTION_STATUSES,
  AGENT_RUN_INTERRUPT_REASONS,
  AGENT_RUN_NOT_RESUMABLE_REASONS,
  AGENT_RUN_RESUME_BLOCK_REASONS,
  AGENT_RUN_STATUSES,
  AGENT_RUN_TERMINAL_REASONS,
  APPROVAL_RESOLUTIONS,
  parseAgentRunErrorCode,
} from "./agentRunTypes.js";
import type { AnalysisReadBasisEntryV1 } from "./agentRunTypes.js";

const dbSource = new URL(
  "../../src-tauri/crates/grimodex-db/src/",
  import.meta.url,
);
const rust = readFileSync(new URL("agent_runs.rs", dbSource), "utf8");
const migration = readFileSync(new URL("migrate.rs", dbSource), "utf8");

function captures(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!);
}

function sqlArms(type: string): string {
  const body = new RegExp(
    "impl " +
      type +
      " \\{\\s*fn sql\\(self\\)[^{]*\\{\\s*match self \\{([\\s\\S]*?)^\\}",
    "mu",
  ).exec(rust)?.[1];
  expect(body, type).toBeDefined();
  return body!;
}

function sqlWords(sql: string): string[] {
  return captures(sql, /'([^']+)'/gu);
}

function snapshotReasons(column: string): string[] {
  const body = new RegExp(
    "\\b" + column + "\\s*=\\s*CASE\\b([\\s\\S]*?)\\bEND\\b",
    "u",
  ).exec(rust)?.[1];
  expect(body, column).toBeDefined();
  return captures(body!, /(?:THEN|ELSE)\s+'([^']+)'/gu);
}

describe("AgentRun vocabulary matches Rust and the migration", () => {
  it("matches the Run status CHECK and the native active statuses", () => {
    const statusCheck =
      /CREATE TABLE IF NOT EXISTS agent_runs\s*\([^;]*?\bstatus TEXT NOT NULL CHECK\s*\(\s*status IN\s*\(([^)]*)\)/u.exec(
        migration,
      )?.[1];
    expect(statusCheck).toBeDefined();
    expect([...AGENT_RUN_STATUSES].sort()).toEqual(
      sqlWords(statusCheck!).sort(),
    );

    const activeIndex =
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_one_active_session\b[^;]*?\bWHERE status IN\s*\(([^)]*)\)/u.exec(
        migration,
      )?.[1];
    expect(activeIndex).toBeDefined();
    expect(
      captures(sqlArms("ActiveStatus"), /=>\s*"([^"]+)"/gu).sort(),
    ).toEqual(
      sqlWords(activeIndex!)
        .filter((status) => status !== "finalizing")
        .sort(),
    );
  });

  it("matches terminal reasons and their per-status CHECK", () => {
    const outcomes = [
      ...sqlArms("TerminalOutcome").matchAll(
        /=>\s*\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,?\s*\)/gu,
      ),
    ];
    expect([...AGENT_RUN_TERMINAL_REASONS].sort()).toEqual(
      outcomes.map(([, , reason]) => reason).sort(),
    );

    const runTable =
      /CREATE TABLE IF NOT EXISTS agent_runs\s*\(([^;]+)\);/u.exec(
        migration,
      )?.[1];
    expect(runTable).toBeDefined();
    const terminalChecks = runTable!.matchAll(
      /status\s*=\s*'([^']+)'\s+AND terminal_reason IS NOT NULL AND terminal_reason IN\s*\(([^)]*)\)/gu,
    );
    const checkedPairs = Array.from(terminalChecks).flatMap(
      ([, status, list]) => sqlWords(list!).map((reason) => [status, reason]),
    );
    expect(checkedPairs.sort()).toEqual(
      outcomes.map(([, status, reason]) => [status, reason]).sort(),
    );
  });

  it("matches interaction statuses written by SQL and approval invalidation", () => {
    // DR-A3-20 leaves Interaction statuses to Native, with no migration CHECK.
    const statuses = new Set(
      captures(sqlArms("ApprovalInvalidation"), /=>\s*"([^"]+)"/gu),
    );
    for (const [, columns, values] of rust.matchAll(
      /INSERT INTO agent_run_interactions\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gu,
    )) {
      const statusIndex = columns!
        .split(",")
        .map((column) => column.trim())
        .indexOf("status");
      expect(statusIndex).toBeGreaterThanOrEqual(0);
      for (const status of sqlWords(values!.split(",")[statusIndex]!)) {
        statuses.add(status);
      }
    }
    for (const [update] of rust.matchAll(
      /UPDATE agent_run_interactions\b([^"]+)/gu,
    )) {
      // EXISTS can refer to agent_runs.status in the same statement.
      const sql = update.split(/\bAND EXISTS\b/u)[0]!;
      for (const status of captures(sql, /\bstatus\s*=\s*'([^']+)'/gu)) {
        statuses.add(status);
      }
      for (const [, body] of sql.matchAll(
        /\bstatus\s*=\s*CASE\b([\s\S]*?)\bEND\b/gu,
      )) {
        for (const status of captures(body!, /(?:THEN|ELSE)\s+'([^']+)'/gu)) {
          statuses.add(status);
        }
      }
    }
    expect([...AGENT_RUN_INTERACTION_STATUSES].sort()).toEqual(
      [...statuses].sort(),
    );
  });

  it.each([
    ["InterruptReason", "interrupt_reason", AGENT_RUN_INTERRUPT_REASONS],
    [
      "NotResumableReason",
      "not_resumable_reason",
      AGENT_RUN_NOT_RESUMABLE_REASONS,
    ],
  ] as const)(
    "matches %s, including snapshot reads",
    (type, column, expected) => {
      expect([...expected].sort()).toEqual(
        [
          ...captures(sqlArms(type), /=>\s*"([^"]+)"/gu),
          ...snapshotReasons(column),
        ].sort(),
      );
    },
  );

  it("matches approval resolutions", () => {
    expect([...APPROVAL_RESOLUTIONS].sort()).toEqual(
      captures(sqlArms("ApprovalDecision"), /=>\s*"([^"]+)"/gu).sort(),
    );
  });

  it("matches the resume gate reasons in DB and N-API", () => {
    const napi = readFileSync(
      new URL("../native/grimodex-node/src/agent_runs.rs", import.meta.url),
      "utf8",
    );
    const napiVariants =
      /#\[serde\(remote = "ResumeBlockReason", rename_all = "snake_case"\)\]\s*enum ResumeBlockReasonWire \{([^}]*)\}/u.exec(
        napi,
      )?.[1];
    expect(napiVariants).toBeDefined();
    const expected = [...AGENT_RUN_RESUME_BLOCK_REASONS].sort();
    expect(
      captures(napiVariants!, /^[ \t]*(\w+),[ \t]*$/gmu)
        .map((variant) =>
          variant.replace(/([a-z])([A-Z])/gu, "$1_$2").toLowerCase(),
        )
        .sort(),
    ).toEqual(expected);
    expect(
      captures(sqlArms("ResumeBlockReason"), /=>\s*"([^"]+)"/gu).sort(),
    ).toEqual(expected);
  });

  it.each([
    ["CapabilityState", AGENT_RUN_CAPABILITY_STATES],
    ["ExecutionState", AGENT_RUN_EXECUTION_STATES],
  ] as const)(
    "matches the snake_case serialization of %s",
    (type, expected) => {
      const body = new RegExp(
        '#\\[serde\\(rename_all = "snake_case"\\)\\]\\s*pub enum ' +
          type +
          " \\{([^}]*)\\}",
        "u",
      ).exec(rust)?.[1];
      expect(body, type).toBeDefined();
      const variants = captures(body!, /^[ \t]*(\w+),?[ \t]*$/gmu);
      expect([...expected].sort()).toEqual(
        variants
          .map((variant) =>
            variant
              .replace(/([A-Z])/gu, "_$1")
              .slice(1)
              .toLowerCase(),
          )
          .sort(),
      );
    },
  );

  it("matches every AGENT_RUN marker in the DB and N-API sources", () => {
    const napi = readFileSync(
      new URL("../native/grimodex-node/src/agent_runs.rs", import.meta.url),
      "utf8",
    );
    const markers = captures(rust + napi, /"(AGENT_RUN_[A-Z0-9_]+)\b/gu);
    expect([...AGENT_RUN_ERROR_CODES].sort()).toEqual(
      [...new Set(markers)].sort(),
    );
  });
});

describe("AgentRun TypeScript boundaries", () => {
  it("returns only a known complete marker from a Native error", () => {
    for (const code of AGENT_RUN_ERROR_CODES) {
      expect(
        parseAgentRunErrorCode(new Error("Native error: " + code + ": detail")),
      ).toBe(code);
    }
    expect(
      parseAgentRunErrorCode("AGENT_RUN_UNKNOWN: AGENT_RUN_NOT_FOUND"),
    ).toBe("AGENT_RUN_NOT_FOUND");
    expect(parseAgentRunErrorCode("OTHER_AGENT_RUN_NOT_FOUND")).toBeNull();
    expect(parseAgentRunErrorCode("AGENT_RUN_NOT_FOUND_EXTRA")).toBeNull();
    expect(parseAgentRunErrorCode("AGENT_RUN_NOT_FOUNDextra")).toBeNull();
    expect(parseAgentRunErrorCode(null)).toBeNull();
  });

  it("requires exactly one revision field in a read basis entry", () => {
    type Source = { sourceKind: string; sourceId: string };
    expectTypeOf<
      Source & { version: string }
    >().toExtend<AnalysisReadBasisEntryV1>();
    expectTypeOf<
      Source & { contentHash: string }
    >().toExtend<AnalysisReadBasisEntryV1>();
    expectTypeOf<Source>().not.toExtend<AnalysisReadBasisEntryV1>();
    expectTypeOf<
      Source & { version: string; contentHash: string }
    >().not.toExtend<AnalysisReadBasisEntryV1>();
  });
});
