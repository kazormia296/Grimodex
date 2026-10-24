/**
 * Test support: the restricted shape of the renderer's generic SQL
 * (`db_execute`) as Main's early classification and Native's authorizer
 * enforce it after O-2 (K3/2 "restricted 下の route 区分"; measured by ST4-A in
 * `src-tauri/crates/grimodex-db/tests/d2a_restricted_generic_sql_shapes.rs`,
 * DR-DA2-52):
 *
 * - any statement with RETURNING is refused;
 * - DML on the read-open tables the DA-2b writers own (`chat_sessions`,
 *   `chat_messages`, `content_versions`, `impact_review_baselines`) and the
 *   DELETE of `project_snapshots` (its CASCADE reaches read-open children)
 *   are refused;
 * - reads and the plain DML of tables outside the D2a table ledger (Map,
 *   labels, prompt templates, pins) pass.
 *
 * It wraps a browser-mock `invoke` so a renderer function can be run in the
 * restricted shape against a real SQLite. Only for tests.
 */
export const D2A_RESTRICTED_DB_EXECUTE_DENIAL =
  "db_execute rejected: D2A_EGRESS_DENIED: plaintext-publication: route db_execute is unavailable in profile local-only mode";

const READ_OPEN_WRITER_TABLES =
  /^\s*(?:insert\s+(?:or\s+\w+\s+)?into|update|delete\s+from)\s+"?(chat_sessions|chat_messages|content_versions|impact_review_baselines)"?\b/i;
const SNAPSHOT_DELETE = /^\s*delete\s+from\s+"?project_snapshots"?(?:\s|$)/i;

export function isRestrictedGenericSqlRefused(sql: string): boolean {
  return (
    /\breturning\b/i.test(sql) ||
    READ_OPEN_WRITER_TABLES.test(sql) ||
    SNAPSHOT_DELETE.test(sql)
  );
}

export function restrictedGenericSql<
  T extends (command: string, args?: Record<string, unknown>) => unknown,
>(invoke: T): T {
  return ((command: string, args?: Record<string, unknown>) => {
    if (
      command === "db_execute" &&
      isRestrictedGenericSqlRefused(String(args?.sql ?? ""))
    ) {
      return Promise.reject(new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL));
    }
    return invoke(command, args);
  }) as T;
}
