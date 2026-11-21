import type { NapiBackendLike } from "../../shared/ipcContract.js";
import { MAIN_READ_CALLER_TIMEOUT_MS } from "../../shared/ipcCallerTimeouts.js";
import type { CoreReadDbClient } from "../../shared/mastraRead/ports.js";
import { checkReadSql } from "../../shared/mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../shared/mastraRead/tables.js";
import type { MainIssuedCallerIdentity } from "../profileEgress.js";
import { MainReadError } from "./errors.js";
import { runNativeRead, type MainReadHooks } from "./nativeCall.js";

/**
 * Electron main's DB read adapter for the read core (Mastra migration MP-4b,
 * DR-MP4-4). It is the `sqlite-proxy` client Drizzle calls for a read tool,
 * wrapped around `backend.dbExecute`, and no caller uses it yet.
 *
 * WHAT THE CHECKS ARE. The send-side checks (a statement that starts with
 * SELECT, a method of `all` or `values`, array params, tables from the
 * allowlist) are ONE LAYER OF DEFENCE and not a proof that a statement is
 * read-only: SQLite accepts text such a check passes and that still does
 * something unintended, and in an unrestricted profile Native itself adds no
 * read-only enforcement (T13, D16). The marker check on the answer is the
 * second layer; the core's own allowlisted Drizzle selects are the third.
 *
 * WHAT IS NOT SENT. Nothing but a statement that passed. `get` is refused: for
 * Drizzle's `get`, `sqlite-proxy` expects one flat array, while Native answers
 * an array of one object, and no read tool uses `.get()`. A read that needs it
 * adds the `rows[0]` branch and its test here. The fifth argument of
 * `dbExecute` (`own_data_read`) is never set: no restricted turn exists
 * (DR-MP4-5), and in an unrestricted profile it has no effect. A decision to
 * allow a restricted turn must revisit this line.
 *
 * WHICH IDENTITY. The caller identity is the one the turn was issued, as JSON,
 * the fourth argument. It never comes from the renderer's claim.
 *
 * LIFECYCLE. `assertLive` and `trackInFlight` (see `MainReadHooks`) are PR-2's
 * seams. The caller timeout does not stop Native. It is a copy of the
 * renderer's values, not an equivalence: the renderer cuts a `db_execute` at
 * 10 s only when its own read-only classification accepts the statement and
 * otherwise waits without a timeout, whereas main sends only statements its
 * own check let through and always cuts them at 10 s.
 */
export interface MainReadDbOptions extends MainReadHooks {
  readonly backend: Pick<NapiBackendLike, "dbExecute">;
  /** The identity Main issued this turn. */
  readonly identity: MainIssuedCallerIdentity;
}

const ALLOWED_METHODS: ReadonlySet<string> = new Set(["all", "values"]);
const RESULT_KEYS = ["__grimodexDbResultKind", "rows"] as const;
const MARKER_KEY = "__grimodexDbResultKind";

export function createMainReadDb(options: MainReadDbOptions): CoreReadDbClient {
  const { identity } = options;
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity)
  ) {
    throw new MainReadError(
      "identity",
      "main read db: a caller identity is required",
    );
  }
  const identityJson = JSON.stringify(identity);
  return async (sql, params, method) => {
    // Everything below up to `runNativeRead` runs before anything is sent.
    if (typeof method !== "string" || !ALLOWED_METHODS.has(method)) {
      throw new MainReadError(
        "method",
        `main read db: method ${String(method)} is not sent (all and values only)`,
        { command: "db_execute" },
      );
    }
    if (!Array.isArray(params)) {
      throw new MainReadError(
        "params",
        "main read db: params must be an array",
        {
          command: "db_execute",
        },
      );
    }
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) {
      throw new MainReadError(
        checked.code,
        `main read db: statement not sent (${checked.code}: ${checked.detail})`,
        { command: "db_execute" },
      );
    }
    const raw = await runNativeRead(
      // Exactly four arguments: the fifth (own_data_read) is not passed.
      () => options.backend.dbExecute(sql, params, method, identityJson),
      {
        command: "db_execute",
        timeoutMs: MAIN_READ_CALLER_TIMEOUT_MS.db_execute,
        hooks: options,
      },
    );
    return { rows: parseNativeReadResult(raw) };
  };
}

/**
 * Parses what `dbExecute` returned into Drizzle's positional rows, or throws.
 *
 * Native answers `{rows, __grimodexDbResultKind}` where each row is an object
 * (column name to value; a repeated column name gets a `\u0000N` suffix, so a
 * row keeps all its columns). The marker must be exactly `read`: a
 * `committed-mutation`, an invalid answer and a receipt without a marker (the
 * `{"rows":[],"committed":true}` of a failed re-authorisation) all throw. The
 * marker is consumed here and never reaches a tool result or the model.
 */
export function parseNativeReadResult(raw: unknown): unknown[][] {
  if (typeof raw !== "string") {
    throw new MainReadError(
      "result-shape",
      "main read db: the answer is not text",
      {
        command: "db_execute",
      },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MainReadError(
      "result-shape",
      "main read db: the answer is not JSON",
      {
        command: "db_execute",
      },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MainReadError(
      "result-shape",
      "main read db: the answer is not an object",
      {
        command: "db_execute",
      },
    );
  }
  const answer = parsed as Record<string, unknown>;
  if (answer[MARKER_KEY] !== "read") {
    throw new MainReadError(
      "result-marker",
      "main read db: the answer is not marked as a read",
      { command: "db_execute" },
    );
  }
  const keys = Object.keys(answer).sort();
  if (
    keys.length !== RESULT_KEYS.length ||
    keys.some((k, i) => k !== RESULT_KEYS[i])
  ) {
    throw new MainReadError(
      "result-key",
      "main read db: the answer has unexpected keys",
      {
        command: "db_execute",
      },
    );
  }
  const rows = answer.rows;
  if (!Array.isArray(rows)) {
    throw new MainReadError(
      "result-shape",
      "main read db: rows is not an array",
      {
        command: "db_execute",
      },
    );
  }
  return rows.map(rowToPositional);
}

/**
 * An integer-like key: `Object.values` lists those first, in numeric order,
 * whatever order they were written in, so a row with a column named `1` (for
 * example `select 1`) would not keep its columns in place.
 */
const INTEGER_LIKE_KEY = /^(?:0|[1-9][0-9]*)$/u;

/** One Native row (an object) to Drizzle's position-ordered array. */
export function rowToPositional(row: unknown): unknown[] {
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new MainReadError(
      "result-shape",
      "main read db: a row is not an object",
      {
        command: "db_execute",
      },
    );
  }
  const record = row as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (INTEGER_LIKE_KEY.test(key)) {
      throw new MainReadError(
        "result-shape",
        "main read db: a column has an integer-like name; its position cannot be kept",
        { command: "db_execute" },
      );
    }
  }
  return Object.values(record);
}
