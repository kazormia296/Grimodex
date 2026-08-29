import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";

export const C2ZC_RENDERER_MCP_DML_DENIAL_ID = "c2-zc-renderer-mcp-dml-denial";

// This auxiliary boundary journey deliberately has one launch and one
// representative probe. Scheduler lifecycle, multi-launch persistence, and
// direct-database corruption are owned by Rust acceptance gates.
export const C2ZC_RENDERER_MCP_DML_DENIAL_PHASES = Object.freeze([
  `${C2ZC_RENDERER_MCP_DML_DENIAL_ID}/representative`,
]);
export const C2ZC_RENDERER_DML_PHASE_ALLOWLIST = Object.freeze([
  ...C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
]);

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export const C2ZC_MCP_GENERIC_SQL_CONTRACT = Object.freeze({
  productionToolName: null,
  productionRoute: null,
  status: "not-exposed",
  canonicalRustSource: "src-tauri/crates/grimodex-db/src/execute.rs",
  canonicalRustTest:
    "c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
  origin: "SqlOrigin::McpGeneric",
});

export const C2ZC_RUST_DML_ACCEPTANCE_REFERENCES = Object.freeze({
  status: "delegated-to-rust-acceptance-receipt",
  allTableGate: Object.freeze({
    source: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustSource,
    test: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustTest,
  }),
  typedWriter: Object.freeze({
    source: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustSource,
    test: C2ZC_MCP_GENERIC_SQL_CONTRACT.canonicalRustTest,
  }),
  directDatabaseCorruption: Object.freeze({
    source:
      "src-tauri/crates/grimodex-db/src/narrative_extraction/c2z_preparation.rs",
    test: "rebuild_outcome_tamper_and_missing_evidence_fail_closed",
  }),
});

// The Rust acceptance test owns the protected-table matrix. This one real
// representative case only proves the renderer IPC boundary is non-vacuous.
export const C2ZC_RENDERER_REPRESENTATIVE_DML_CASE = Object.freeze({
  table: "narrative_runtime_policy",
  operation: "UPDATE",
  keyColumn: "singleton_id",
  keyValue: 1,
  mutableColumn: "version",
  mutableSentinel: "c2-zc-renderer-dml-denial-sentinel",
});

export const C2ZC_RENDERER_DML_EVIDENCE_VERSION = 3;
export const C2ZC_RENDERER_DML_TIMELINE_EVENT =
  "c2-zc-renderer-dml-representative-denial";

export const C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY = Object.freeze({
  id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  required: true,
  acceptanceRole: "auxiliary",
  domains: Object.freeze(["narrative-maintenance", "sqlite"]),
  interactions: Object.freeze(["narrative-maintenance->sqlite"]),
  contracts: Object.freeze(["c2-zc:boundary-dml-denial"]),
  capabilities: Object.freeze(["electron", "napi"]),
  description:
    "one-launch, one representative real renderer IPC db_execute DML denial with an unchanged row; all-table, MCP, typed-positive, and direct-corruption proofs are bound to Rust acceptance gates",
  phases: C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  mcpGeneric: C2ZC_MCP_GENERIC_SQL_CONTRACT,
});

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (
    actual.length !== keys.length ||
    actual.some((key, index) => key !== keys[index])
  ) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function assertC2ZcNativeWorkspaceBinding(
  value,
  label = "C2-ZC Native workspace binding",
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertExactKeys(
    value,
    ["authorityId", "authorityInstanceId", "generation"],
    label,
  );
  if (
    typeof value.authorityId !== "string" ||
    value.authorityId.length === 0 ||
    value.authorityId.trim() !== value.authorityId ||
    value.authorityId.includes("\u0000")
  ) {
    throw new Error(`${label} authorityId is invalid`);
  }
  if (!Number.isSafeInteger(value.generation) || value.generation <= 0) {
    throw new Error(`${label} generation is invalid`);
  }
  if (
    typeof value.authorityInstanceId !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.authorityInstanceId)
  ) {
    throw new Error(`${label} authorityInstanceId is invalid`);
  }
  return Object.freeze({
    authorityId: value.authorityId,
    generation: value.generation,
    authorityInstanceId: value.authorityInstanceId,
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function rowsOf(result, label) {
  if (!result || typeof result !== "object" || !Array.isArray(result.rows)) {
    throw new Error(`${label} did not return rows[]`);
  }
  return result.rows;
}

async function readRows(harness, page, sql, params, label) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
    label,
  );
}

async function captureBinding(harness, page, workspace) {
  const binding = await harness.invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspace },
  );
  return assertC2ZcNativeWorkspaceBinding(binding);
}

function representativeSelectSql(dmlCase) {
  return `SELECT * FROM ${quoteIdentifier(dmlCase.table)} WHERE ${quoteIdentifier(
    dmlCase.keyColumn,
  )} = ? ORDER BY ${quoteIdentifier(dmlCase.keyColumn)} ASC`;
}

function representativeUpdateSql(dmlCase) {
  return `UPDATE ${quoteIdentifier(dmlCase.table)} SET ${quoteIdentifier(
    dmlCase.mutableColumn,
  )} = ? WHERE ${quoteIdentifier(dmlCase.keyColumn)} = ?`;
}

function requireSingleRepresentativeRow(rows, dmlCase, label) {
  if (rows.length !== 1) {
    throw new Error(`${label} must contain exactly one representative row`);
  }
  const [row] = rows;
  if (
    !Object.hasOwn(row, dmlCase.keyColumn) ||
    canonicalJson(row[dmlCase.keyColumn]) !== canonicalJson(dmlCase.keyValue)
  ) {
    throw new Error(`${label} row has an unexpected representative key`);
  }
  return row;
}

async function expectProtectedWriterDenial(harness, page, dmlCase) {
  const sql = representativeUpdateSql(dmlCase);
  const params = [dmlCase.mutableSentinel, dmlCase.keyValue];
  try {
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "run",
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (
      !message.includes(
        "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
      )
    ) {
      throw new Error(
        `${dmlCase.operation} ${dmlCase.table} returned an unstable denial: ${message}`,
        { cause: error },
      );
    }
    return {
      operation: dmlCase.operation,
      table: dmlCase.table,
      sql,
      params,
      denial:
        "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
    };
  }
  return {
    operation: dmlCase.operation,
    table: dmlCase.table,
    sql,
    params,
    unexpectedSuccess: true,
  };
}

/**
 * The DML lane proves only the renderer boundary: one workspace migration that
 * seeds the Native-owned runtime-policy singleton, one Native binding, one
 * protected-table write denial, and immediate row equality. The representative
 * row is intentionally independent of project lifecycle and therefore exists
 * before C2-ZC cutover. All scheduler/readiness, multi-launch, and
 * external-corruption claims remain delegated to the Rust acceptance receipt.
 */
export async function runC2ZcRendererMcpDmlDenialJourney(harness) {
  if (
    !harness ||
    typeof harness.workspacePath !== "function" ||
    typeof harness.launch !== "function" ||
    typeof harness.close !== "function" ||
    typeof harness.invokeOk !== "function"
  ) {
    throw new TypeError(
      "C2-ZC DML denial journey requires workspacePath, launch, close, and invokeOk",
    );
  }

  const workspace = harness.workspacePath(C2ZC_RENDERER_MCP_DML_DENIAL_ID);
  await mkdir(workspace, { recursive: true });
  const phase = C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0];
  const dmlCase = C2ZC_RENDERER_REPRESENTATIVE_DML_CASE;
  let launched = null;
  try {
    launched = await harness.launch(phase);
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });

    // Capture the exact native binding before any raw db_execute read/write.
    const binding = await captureBinding(harness, launched.page, workspace);

    const selectSql = representativeSelectSql(dmlCase);
    const beforeRows = await readRows(
      harness,
      launched.page,
      selectSql,
      [dmlCase.keyValue],
      `representative ${dmlCase.table} before`,
    );
    const beforeRow = requireSingleRepresentativeRow(
      beforeRows,
      dmlCase,
      `representative ${dmlCase.table} before`,
    );
    const beforeMutableValue = beforeRow[dmlCase.mutableColumn];
    if (
      !Object.hasOwn(beforeRow, dmlCase.mutableColumn) ||
      canonicalJson(beforeMutableValue) ===
        canonicalJson(dmlCase.mutableSentinel)
    ) {
      throw new Error(
        `representative ${dmlCase.table} before row must have a distinct mutable value`,
      );
    }
    const denial = await expectProtectedWriterDenial(
      harness,
      launched.page,
      dmlCase,
    );
    const afterRows = await readRows(
      harness,
      launched.page,
      selectSql,
      [dmlCase.keyValue],
      `representative ${dmlCase.table} after`,
    );
    const afterRow = requireSingleRepresentativeRow(
      afterRows,
      dmlCase,
      `representative ${dmlCase.table} after`,
    );
    const afterMutableValue = afterRow[dmlCase.mutableColumn];
    const beforeDigest = sha256Canonical(beforeRows);
    const afterDigest = sha256Canonical(afterRows);
    if (beforeDigest !== afterDigest) {
      throw new Error(
        `${dmlCase.table} changed immediately after protected writer denial`,
      );
    }
    if (
      canonicalJson(beforeMutableValue) !== canonicalJson(afterMutableValue)
    ) {
      throw new Error(
        `${dmlCase.table}.${dmlCase.mutableColumn} changed immediately after protected writer denial`,
      );
    }
    if (denial.unexpectedSuccess) {
      throw new Error(
        `${dmlCase.operation} ${dmlCase.table} unexpectedly succeeded through renderer`,
      );
    }

    const evidence = {
      evidenceVersion: C2ZC_RENDERER_DML_EVIDENCE_VERSION,
      kind: C2ZC_RENDERER_DML_TIMELINE_EVENT,
      workspace,
      binding,
      representativeProbe: {
        ...denial,
        keyColumn: dmlCase.keyColumn,
        keyValue: dmlCase.keyValue,
        mutableColumn: dmlCase.mutableColumn,
        beforeRow,
        afterRow,
        beforeMutableValue,
        afterMutableValue,
        unchanged: true,
        beforeRows,
        afterRows,
        beforeDigest,
        afterDigest,
      },
      rustAcceptance: C2ZC_RUST_DML_ACCEPTANCE_REFERENCES,
      scope: "immediate-row-equality-only",
    };
    if (typeof harness.recordTimeline === "function") {
      harness.recordTimeline(C2ZC_RENDERER_DML_TIMELINE_EVENT, { evidence });
    }
    await harness.close(launched.app, launched.page, phase);
    launched = null;
    return {
      id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
      workspace,
      rendererDenials: 1,
      evidence,
      mcpGeneric: C2ZC_MCP_GENERIC_SQL_CONTRACT,
    };
  } finally {
    if (launched) {
      await harness.close(
        launched.app,
        launched.page,
        `${C2ZC_RENDERER_MCP_DML_DENIAL_ID}/cleanup`,
      );
    }
  }
}

export const C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY = Object.freeze({
  id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  run: runC2ZcRendererMcpDmlDenialJourney,
});
