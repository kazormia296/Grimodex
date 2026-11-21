/**
 * The pre-send check of the SQL Electron main's read port sends to Native
 * (Mastra migration MP-4b, DR-MP4-4 rule 1 and DR-MP4-21).
 *
 * This is ONE LAYER OF DEFENCE, NOT A PROOF THAT A STATEMENT IS READ-ONLY.
 * It reads only the lexical shape of the text:
 *   - the first code token must be `select` (any case; leading whitespace and
 *     comments are skipped), so `with ... delete` is refused;
 *   - there is no second statement (only a trailing `;` is allowed);
 *   - every table the statement names after `from` / `join` is in an allowlist
 *     (a table-valued function, a comma join and a table it cannot read are
 *     refused; a subquery is read through its own `from`; a parenthesis after
 *     `from`/`join` that does not open a `select`, and an `in` that is not
 *     followed by a parenthesis, are refused because both can name a table
 *     without being read as one).
 * SQLite still accepts text this check passes and that does something it was
 * not meant to (a function with a side effect, for example), and the check
 * knows nothing about views or triggers. The other layers are the marker Native
 * returns (`read` only), the allowlisted Drizzle selects of the core, and, in a
 * restricted profile, Native itself. In an unrestricted profile Native adds no
 * read-only enforcement of its own (threat model T13, D16).
 *
 * It is a lexer plus a linear pass, with no parser: a shape it cannot read is
 * refused (fail closed). It is pure and takes no dependency.
 */

export type ReadSqlRefusalCode =
  | "unlexable"
  | "not-select"
  | "multi-statement"
  | "comma-join"
  | "table-function"
  | "table-unreadable"
  | "table-not-allowed";

export type ReadSqlCheck =
  | { readonly ok: true; readonly tables: readonly string[] }
  | {
      readonly ok: false;
      readonly code: ReadSqlRefusalCode;
      readonly detail: string;
    };

type TokenKind = "word" | "ident" | "string" | "punct" | "other";

interface Token {
  readonly kind: TokenKind;
  /** A word as written; an identifier without its quotes; punctuation itself. */
  readonly text: string;
}

const WORD_START = /[A-Za-z_\u0080-￿]/u;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/u;
const WHITESPACE = /\s/u;

/**
 * Splits SQL into tokens, dropping comments and whitespace. `null` when the
 * text has a NUL character or an unterminated string, quoted identifier or
 * block comment (SQLite itself would read an unterminated block comment as a
 * comment to the end; refusing it is stricter and safe).
 */
function lex(sql: string): Token[] | null {
  const tokens: Token[] = [];
  const length = sql.length;
  let i = 0;
  while (i < length) {
    const ch = sql[i]!;
    if (ch === "\u0000") return null;
    if (WHITESPACE.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? length : end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 2;
      continue;
    }
    if (ch === "'") {
      const end = skipQuoted(sql, i, "'");
      if (end === -1) return null;
      tokens.push({ kind: "string", text: sql.slice(i + 1, end - 1) });
      i = end;
      continue;
    }
    if (ch === '"' || ch === "`") {
      const end = skipQuoted(sql, i, ch);
      if (end === -1) return null;
      tokens.push({
        kind: "ident",
        text: sql.slice(i + 1, end - 1).replaceAll(ch + ch, ch),
      });
      i = end;
      continue;
    }
    if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      if (end === -1) return null;
      tokens.push({ kind: "ident", text: sql.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < length && WORD_PART.test(sql[j]!)) j += 1;
      tokens.push({ kind: "word", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < length && /[0-9A-Za-z_.]/u.test(sql[j]!)) j += 1;
      tokens.push({ kind: "other", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "?" || ch === ":" || ch === "@" || ch === "$") {
      let j = i + 1;
      while (j < length && WORD_PART.test(sql[j]!)) j += 1;
      tokens.push({ kind: "other", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === ".") {
      tokens.push({ kind: "punct", text: ch });
      i += 1;
      continue;
    }
    tokens.push({ kind: "other", text: ch });
    i += 1;
  }
  return tokens;
}

/** The index just after the closing quote, or -1. A doubled quote is an escape. */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

/** Keywords that end a `from` clause at their own parenthesis depth. */
const FROM_TERMINATORS: ReadonlySet<string> = new Set([
  "where",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "window",
  "union",
  "intersect",
  "except",
]);

function refuse(code: ReadSqlRefusalCode, detail: string): ReadSqlCheck {
  return { ok: false, code, detail };
}

/**
 * Checks one SQL text. `allowedTables` holds lower-case table names; a table is
 * compared by its lower-case name (SQLite names are case-insensitive).
 */
export function checkReadSql(
  sql: unknown,
  allowedTables: ReadonlySet<string>,
): ReadSqlCheck {
  if (typeof sql !== "string")
    return refuse("not-select", "sql is not a string");
  const tokens = lex(sql);
  if (tokens === null) return refuse("unlexable", "unterminated or NUL text");
  const first = tokens[0];
  if (
    first === undefined ||
    first.kind !== "word" ||
    first.text.toLowerCase() !== "select"
  ) {
    return refuse("not-select", "the first code token is not SELECT");
  }
  const semicolon = tokens.findIndex(
    (token) => token.kind === "punct" && token.text === ";",
  );
  if (semicolon !== -1 && semicolon !== tokens.length - 1) {
    return refuse("multi-statement", "text follows a statement terminator");
  }

  const tables: string[] = [];
  /** The paren depths where a `from` clause is open (innermost last). */
  const fromDepths: number[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "punct") {
      if (token.text === "(") {
        depth += 1;
      } else if (token.text === ")") {
        depth -= 1;
        if (depth < 0) return refuse("unlexable", "unbalanced parenthesis");
        while (fromDepths.length > 0 && fromDepths.at(-1)! > depth) {
          fromDepths.pop();
        }
      } else if (
        token.text === "," &&
        fromDepths.length > 0 &&
        fromDepths.at(-1) === depth
      ) {
        return refuse("comma-join", "a comma join is not read");
      }
      continue;
    }
    if (token.kind !== "word") continue;
    const keyword = token.text.toLowerCase();
    if (FROM_TERMINATORS.has(keyword)) {
      while (fromDepths.length > 0 && fromDepths.at(-1)! >= depth) {
        fromDepths.pop();
      }
      continue;
    }
    if (keyword === "in") {
      // `x IN some_table` (and `IN json_each(...)`) names a table with no
      // `from`. Only `IN ( ... )` is read; a subquery inside has its own `from`.
      const after = tokens[index + 1];
      if (after === undefined || after.kind !== "punct" || after.text !== "(") {
        return refuse(
          "table-unreadable",
          "in is not followed by a parenthesis",
        );
      }
      continue;
    }
    if (keyword !== "from" && keyword !== "join") continue;
    if (keyword === "from") fromDepths.push(depth);
    const next = tokens[index + 1];
    if (next === undefined) {
      return refuse("table-unreadable", `${keyword} has no table`);
    }
    // A subquery: its own `from` is read as we go. A parenthesis that does not
    // open a `select` (`from (some_table)`, `from (a, b)`) would hide table
    // names from this pass, so it is refused.
    if (next.kind === "punct" && next.text === "(") {
      let inner = index + 1;
      while (tokens[inner]?.kind === "punct" && tokens[inner]?.text === "(") {
        inner += 1;
      }
      const head = tokens[inner];
      if (head?.kind !== "word" || head.text.toLowerCase() !== "select") {
        return refuse(
          "table-unreadable",
          `${keyword} ( is not followed by a select`,
        );
      }
      continue;
    }
    if (next.kind !== "word" && next.kind !== "ident") {
      return refuse(
        "table-unreadable",
        `${keyword} is not followed by a table`,
      );
    }
    let name = next.text;
    let after = index + 2;
    const dot = tokens[after];
    if (dot?.kind === "punct" && dot.text === ".") {
      const qualified = tokens[after + 1];
      if (
        qualified === undefined ||
        (qualified.kind !== "word" && qualified.kind !== "ident")
      ) {
        return refuse("table-unreadable", "a qualified name is cut short");
      }
      // Another schema (an attached database) is never read.
      if (name.toLowerCase() !== "main") {
        return refuse("table-not-allowed", `schema ${name}`);
      }
      name = qualified.text;
      after += 2;
    }
    const open = tokens[after];
    if (open?.kind === "punct" && open.text === "(") {
      return refuse("table-function", `${name}(...) is not read`);
    }
    const lower = name.toLowerCase();
    if (!allowedTables.has(lower)) {
      return refuse("table-not-allowed", name);
    }
    tables.push(lower);
  }
  return { ok: true, tables };
}
