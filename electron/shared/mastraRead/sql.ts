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
 *     `from`/`join` that does not open exactly one `select`, and an `in` that is
 *     not followed by a parenthesis, are refused because both can name a table
 *     without being read as one);
 *   - the text is read the way SQLite reads it, and only the shapes Drizzle
 *     emits are accepted: white space is the six ASCII characters, anything
 *     non-ASCII outside a string, a quoted identifier or a comment is refused
 *     (SQLite reads it as part of a name), a placeholder is `?` or `?N` (the
 *     named forms `$a`, `:a`, `@a`, `#a` are refused, SQLite's Tcl-style
 *     variable swallows a parenthesis), a table reference is read as
 *     `name [as] [alias]` followed by a join word, `on`, `using`, a clause
 *     word, `)`, `;` or the end (so `offset`, `window` or a second name after a
 *     table cannot hide a comma join), and the parentheses balance.
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

// SQLite's identifier characters: ASCII letters, digits, `_`, `$`, and every
// byte of 0x80 or more. The last is why non-ASCII outside a string, a quoted
// identifier or a comment is refused instead of being read as a space (JS `\s`
// counts U+00A0, U+FEFF and others as white space; SQLite does not).
const WORD_START = /[A-Za-z_]/u;
const WORD_PART = /[A-Za-z0-9_$]/u;
const DIGIT = /[0-9]/u;
const NUMBER_PART = /[0-9A-Za-z_.]/u;
/** SQLite's `sqlite3Isspace`: space, \t, \n, \v, \f, \r. */
const WHITESPACE: ReadonlySet<string> = new Set([
  " ",
  "\t",
  "\n",
  "\u000b",
  "\f",
  "\r",
]);
/** The operator characters Drizzle's SQL uses (`<>`, `!=`, `||`, `->` ...). */
const OPERATOR_CHARS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "!",
  "|",
  "&",
  "~",
]);

/**
 * Splits SQL into tokens, dropping comments and whitespace. `null` when the
 * text has a NUL character, an unterminated string, quoted identifier or block
 * comment (SQLite itself would read an unterminated block comment as a comment
 * to the end; refusing it is stricter and safe), a named placeholder (`$`, `:`,
 * `@`, `#`), or any character outside the sets above (so non-ASCII text
 * outside a string, a quoted identifier or a comment).
 */
function lex(sql: string): Token[] | null {
  if (sql.includes("\u0000")) return null;
  const tokens: Token[] = [];
  const length = sql.length;
  let i = 0;
  while (i < length) {
    const ch = sql[i]!;
    if (WHITESPACE.has(ch)) {
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
    if (DIGIT.test(ch)) {
      let j = i + 1;
      while (j < length && NUMBER_PART.test(sql[j]!)) j += 1;
      tokens.push({ kind: "other", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "?") {
      // SQLite reads `?` and then digits only: `?from` is `?` and `from`.
      let j = i + 1;
      while (j < length && DIGIT.test(sql[j]!)) j += 1;
      tokens.push({ kind: "other", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === ";" || ch === ".") {
      tokens.push({ kind: "punct", text: ch });
      i += 1;
      continue;
    }
    if (OPERATOR_CHARS.has(ch)) {
      tokens.push({ kind: "other", text: ch });
      i += 1;
      continue;
    }
    return null;
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

/**
 * Words that end a table reference list and start a clause. `offset` and
 * `window` are not here: SQLite reads either as an alias after a table, and
 * Drizzle emits `offset` only after `limit`, so after a table they are refused.
 */
const CLAUSE_WORDS: ReadonlySet<string> = new Set([
  "where",
  "group",
  "order",
  "limit",
  "having",
  "union",
  "intersect",
  "except",
]);
const JOIN_WORDS: ReadonlySet<string> = new Set([
  "natural",
  "left",
  "right",
  "full",
  "inner",
  "outer",
  "cross",
]);
/**
 * Words an unquoted alias may not be. A word after `.` is a column name unless
 * it is one of these.
 */
const STRUCTURAL_WORDS: ReadonlySet<string> = new Set([
  ...CLAUSE_WORDS,
  "from",
  "join",
  "in",
  "on",
  "using",
  "select",
  "as",
  "offset",
  "window",
]);

/**
 * Where a parenthesis level is in a table reference list.
 *   none           outside one (the select list, a clause after the list);
 *   expect-table   just after `from` / `join`;
 *   after-table    after a table name or a closed subquery, an alias may follow;
 *   expect-alias   after `as`;
 *   after-alias    the reference is complete: a join word, `on`, `using`, a
 *                  clause word, `)`, `;` or the end may follow, nothing else;
 *   joining        inside `left outer` and the like, only `join` may end it;
 *   join-expr      in an `on` / `using` condition, up to a join word or a clause.
 */
type FromState =
  | "none"
  | "expect-table"
  | "after-table"
  | "expect-alias"
  | "after-alias"
  | "joining"
  | "join-expr";

interface Frame {
  state: FromState;
}

function refuse(code: ReadSqlRefusalCode, detail: string): ReadSqlCheck {
  return { ok: false, code, detail };
}

function isWord(token: Token | undefined, lower: string): boolean {
  return token?.kind === "word" && token.text.toLowerCase() === lower;
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

const CUT_SHORT = "a table reference is cut short";

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
  if (tokens === null) {
    return refuse(
      "unlexable",
      "unterminated text, NUL, a named placeholder or a character SQLite reads differently",
    );
  }
  if (!isWord(tokens[0], "select")) {
    return refuse("not-select", "the first code token is not SELECT");
  }
  const semicolon = tokens.findIndex((token) => isPunct(token, ";"));
  if (semicolon !== -1 && semicolon !== tokens.length - 1) {
    return refuse("multi-statement", "text follows a statement terminator");
  }

  const tables: string[] = [];
  /** One frame per open parenthesis; the first is the statement itself. */
  const frames: Frame[] = [{ state: "none" }];
  let afterDot = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const frame = frames.at(-1)!;
    const state = frame.state;
    const incomplete =
      state === "expect-table" ||
      state === "expect-alias" ||
      state === "joining";
    const inExpression = state === "none" || state === "join-expr";

    if (token.kind === "punct") {
      if (token.text === "(") {
        afterDot = false;
        if (state === "expect-table") {
          // `from ( select`: one parenthesis and a select. `from ((select ...))`
          // and `from (a, b)` would hide a name from this pass.
          if (!isWord(tokens[index + 1], "select")) {
            return refuse(
              "table-unreadable",
              "from/join ( is not followed by a select",
            );
          }
          frame.state = "after-table";
          frames.push({ state: "none" });
        } else if (inExpression) {
          frames.push({ state: "none" });
        } else {
          return refuse(
            "table-unreadable",
            "a parenthesis after a table reference",
          );
        }
        continue;
      }
      if (token.text === ")") {
        if (frames.length === 1) {
          return refuse("unlexable", "unbalanced parenthesis");
        }
        if (incomplete) return refuse("table-unreadable", CUT_SHORT);
        frames.pop();
        continue;
      }
      if (token.text === ",") {
        if (state === "none") continue;
        if (incomplete) return refuse("table-unreadable", CUT_SHORT);
        return refuse("comma-join", "a comma join is not read");
      }
      if (token.text === ";") {
        if (incomplete) return refuse("table-unreadable", CUT_SHORT);
        continue;
      }
      // ".": a name part follows in an expression; after a table reference it
      // has no place (a three-part name, `from .`).
      if (!inExpression) {
        return refuse("table-unreadable", "a dot after a table reference");
      }
      afterDot = true;
      continue;
    }

    if (state === "expect-table") {
      if (token.kind !== "word" && token.kind !== "ident") {
        return refuse(
          "table-unreadable",
          "from/join is not followed by a table",
        );
      }
      let name = token.text;
      let last = index;
      if (isPunct(tokens[last + 1], ".")) {
        const qualified = tokens[last + 2];
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
        last += 2;
      }
      if (isPunct(tokens[last + 1], "(")) {
        return refuse("table-function", `${name}(...) is not read`);
      }
      const lower = name.toLowerCase();
      if (!allowedTables.has(lower)) {
        return refuse("table-not-allowed", name);
      }
      tables.push(lower);
      frame.state = "after-table";
      index = last;
      continue;
    }

    if (state === "expect-alias") {
      if (
        token.kind === "ident" ||
        (token.kind === "word" &&
          !STRUCTURAL_WORDS.has(token.text.toLowerCase()))
      ) {
        frame.state = "after-alias";
        continue;
      }
      return refuse("table-unreadable", "an alias is not a name");
    }

    if (state === "after-table" || state === "after-alias") {
      const keyword =
        token.kind === "word" ? token.text.toLowerCase() : undefined;
      if (state === "after-table") {
        // An alias: `as name`, a quoted name, or a bare word that is neither a
        // keyword of the clause nor a join word.
        if (token.kind === "ident") {
          frame.state = "after-alias";
          continue;
        }
        if (keyword === "as") {
          frame.state = "expect-alias";
          continue;
        }
        if (
          keyword !== undefined &&
          !STRUCTURAL_WORDS.has(keyword) &&
          !JOIN_WORDS.has(keyword)
        ) {
          frame.state = "after-alias";
          continue;
        }
      }
      // The reference is complete. Only a join word, `on`, `using` or a clause
      // word goes on; `offset`, `window`, a second name and a string do not.
      if (keyword !== undefined) {
        if (CLAUSE_WORDS.has(keyword)) {
          frame.state = "none";
          continue;
        }
        if (keyword === "join") {
          frame.state = "expect-table";
          continue;
        }
        if (JOIN_WORDS.has(keyword)) {
          frame.state = "joining";
          continue;
        }
        if (keyword === "on" || keyword === "using") {
          frame.state = "join-expr";
          continue;
        }
      }
      return refuse(
        "table-unreadable",
        `${token.text} is not read after a table reference`,
      );
    }

    if (state === "joining") {
      const keyword =
        token.kind === "word" ? token.text.toLowerCase() : undefined;
      if (keyword === "join") {
        frame.state = "expect-table";
        continue;
      }
      if (keyword !== undefined && JOIN_WORDS.has(keyword)) continue;
      return refuse("table-unreadable", "a join is cut short");
    }

    // `none` and `join-expr`: an expression or a clause.
    if (token.kind !== "word") {
      afterDot = false;
      continue;
    }
    const keyword = token.text.toLowerCase();
    if (afterDot) {
      afterDot = false;
      // `a.left` and `a.offset` are columns (neither starts a table reference).
      // The other structural words after a dot are not skipped: SQLite would
      // not read them as names, and skipping would hide the next table.
      if (
        !STRUCTURAL_WORDS.has(keyword) ||
        keyword === "offset" ||
        keyword === "window"
      ) {
        continue;
      }
    }
    if (keyword === "in") {
      // `x IN some_table` (and `IN json_each(...)`) names a table with no
      // `from`. Only `IN ( ... )` is read; a subquery inside has its own `from`.
      if (!isPunct(tokens[index + 1], "(")) {
        return refuse(
          "table-unreadable",
          "in is not followed by a parenthesis",
        );
      }
      continue;
    }
    if (keyword === "from" || keyword === "join") {
      frame.state = "expect-table";
      continue;
    }
    if (CLAUSE_WORDS.has(keyword)) {
      frame.state = "none";
      continue;
    }
    if (state === "join-expr") {
      if (keyword === "offset" || keyword === "window") {
        return refuse(
          "table-unreadable",
          `${token.text} after a table reference`,
        );
      }
      if (JOIN_WORDS.has(keyword)) frame.state = "joining";
    }
  }

  if (frames.length !== 1) {
    return refuse("unlexable", "unbalanced parenthesis");
  }
  const final = frames[0]!.state;
  if (
    final === "expect-table" ||
    final === "expect-alias" ||
    final === "joining"
  ) {
    return refuse("table-unreadable", CUT_SHORT);
  }
  return { ok: true, tables };
}
