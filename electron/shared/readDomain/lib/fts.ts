/**
 * FTS5 MATCH クエリ生成の共有ユーティリティ。
 *
 * 生のユーザー入力をそのまま `... MATCH ?` に渡すと、カンマ・ハイフン・コロン・
 * 括弧・引用符などが FTS5 のクエリ演算子／カラムフィルタと解釈され、
 * `fts5: syntax error near ","` や `no such column: ...` で検索が落ちる。
 *
 * 対策として各トークンを二重引用符で囲んで「文字列リテラル」化し（演算子を無効化）、
 * トークン同士は OR で連結する。FTS5 既定の AND セマンティクスは複数語の自然文クエリで
 * 空振りしやすいため、検索 UX 上は OR の方が望ましい（既存の Agent 検索ツールと同じ方針）。
 *
 * trigram tokenizer は 3 codepoint 未満のトークンを match できないため、
 * `toFtsMatchQuery` ではそうしたトークンを除外する。一致可能なトークンが無いときは
 * 空文字を返すので、呼び出し側は LIKE フォールバック等で扱うこと。
 *
 * 同等のロジックは Rust 側 `src-tauri/src/database/fts.rs` の `to_fts_match` にもある
 * （両者を同期させること）。
 */

/** 空白区切りでトークン化する。空要素は除外。 */
export function tokenizeFtsQuery(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Unicode コードポイント数（サロゲートペアを 1 と数える）。 */
export function codepointLength(s: string): number {
  return [...s].length;
}

/**
 * トークン群を `"a" OR "b"` 形式の安全な FTS5 MATCH 式へ変換する。
 * 各トークンを二重引用符で囲み、トークン内の二重引用符は `""` にエスケープする。
 */
export function ftsOrMatch(tokens: string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * 生クエリを安全な FTS5 MATCH 式へ変換する。trigram で扱えない 3 codepoint 未満の
 * トークンは除外する。一致可能なトークンが無ければ空文字を返す。
 */
export function toFtsMatchQuery(raw: string): string {
  const tokens = tokenizeFtsQuery(raw).filter((t) => codepointLength(t) >= 3);
  return ftsOrMatch(tokens);
}
