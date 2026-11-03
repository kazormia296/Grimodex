/**
 * 関連場面の sparse 腕（FTS5）に渡す query を組む純関数。
 *
 * - 英語（`language.startsWith("en")`）は従来の `buildSparseQuery(tailQuery, body)` と同じ文字列を返す。
 * - それ以外（日本語の扱い）は、tail を入れず、本文で言及された Codex の名前・別名と、
 *   カタカナ／Latin の固有名詞 seed だけを空白で連結する。Rust の `to_fts_match` が捨てる
 *   3 codepoint 未満の語は先に落とし、落とした後で先頭 8 件にする。
 * - 3 codepoint 以上の語が 1 つも残らなければ、従来の `buildSparseQuery(tailQuery, body)` を返す
 *   （空の query を渡すと Rust が `LIKE '%%'` に落ちるため。sparse は必ず 1 回呼ぶ）。
 *
 * store も IPC も読まない。Codex の行は呼出し元が渡す。設計は
 * `docs/plans/related-scenes-ja-sparse-design-draft.md` の §2.2〜§2.5。
 * CP-4 の harness が `buildSparseQuery` を直接使うので、`seedTerms.ts` は変えない。
 */
import {
  createCodexMatcher,
  parseAliases,
  type CodexMatchTarget,
} from "@/features/codex/codexMatcher";
import { codepointLength, tokenizeFtsQuery } from "@/lib/fts";
import { buildSparseQuery, extractProperNounSeeds } from "./seedTerms";

/** 1 項目あたりに出す表記の上限（名前を先に、別名は登録順）。 */
export const SPARSE_TERMS_PER_ENTRY = 3;
/** query 全体の語の上限（3 codepoint 未満を落とした後で数える）。 */
export const SPARSE_MAX_TERMS = 8;
/** Rust の `to_fts_match` が MATCH に残す最短の語の長さ（codepoint）。 */
const SPARSE_MIN_TERM_CODEPOINTS = 3;

export interface RelatedScenesSparseQueryArgs {
  /** `buildSemanticRecallQuery` の結果（本文の末尾）。戻すときに使う。 */
  tailQuery: string;
  /** `prosemirrorToText` の結果。戻すとき、および docJson が読めないときに使う。 */
  body: string;
  /** `loadSceneContent` の結果（ProseMirror の JSON 文字列）。ルビの base を拾うために使う。 */
  docJson: string;
  /** `getCurrentProjectLanguage()` の値。 */
  language: string;
  /** プロジェクト全体の Codex の行（全種類。type で絞らない）。 */
  codexTargets: readonly CodexMatchTarget[];
}

export function buildRelatedScenesSparseQuery(
  args: RelatedScenesSparseQueryArgs,
): string {
  const { tailQuery, body, docJson, language, codexTargets } = args;
  // recallParamsForLang と同じ述語。英語は従来の文字列のまま。
  if (language.startsWith("en")) return buildSparseQuery(tailQuery, body);

  const matchText = docJsonToMatchText(docJson) ?? body;
  const candidates = [
    ...mentionedCodexTerms(matchText, codexTargets),
    ...extractProperNounSeeds(matchText, Number.POSITIVE_INFINITY),
  ];

  const terms: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const token of tokenizeFtsQuery(candidate)) {
      if (codepointLength(token) < SPARSE_MIN_TERM_CODEPOINTS) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      terms.push(token);
      if (terms.length >= SPARSE_MAX_TERMS) return terms.join(" ");
    }
  }
  return terms.length > 0 ? terms.join(" ") : buildSparseQuery(tailQuery, body);
}

/**
 * 言及された Codex の項目を、一致回数の多い順（同数は最初の位置が早い順）に並べ、
 * 項目ごとに `[名前, ...別名]`（除外の別名は除く。最大 3 語）を出す。
 * 短い別名による言及も数える（一致を長さで絞らない）。
 */
function mentionedCodexTerms(
  text: string,
  codexTargets: readonly CodexMatchTarget[],
): string[] {
  if (!text || codexTargets.length === 0) return [];
  const matches = createCodexMatcher([...codexTargets])(text);
  const stats = new Map<string, { count: number; first: number }>();
  for (const match of matches) {
    const stat = stats.get(match.entryId);
    if (stat) stat.count += 1;
    else stats.set(match.entryId, { count: 1, first: match.from });
  }
  if (stats.size === 0) return [];

  const byId = new Map<string, CodexMatchTarget>();
  for (const target of codexTargets) {
    if (!byId.has(target.id)) byId.set(target.id, target);
  }
  const ordered = [...stats.entries()].sort(
    ([, a], [, b]) => b.count - a.count || a.first - b.first,
  );

  const out: string[] = [];
  for (const [entryId] of ordered) {
    const target = byId.get(entryId);
    if (!target) continue;
    const excluded = new Set(
      parseAliases(target.excludedAliases)
        .filter((alias) => typeof alias === "string")
        .map((alias) => alias.toLowerCase()),
    );
    const names = [target.name, ...parseAliases(target.aliases)]
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      )
      .filter((name) => !excluded.has(name.toLowerCase()))
      .slice(0, SPARSE_TERMS_PER_ENTRY);
    out.push(...names);
  }
  return out;
}

interface PmJsonNode {
  type?: unknown;
  text?: unknown;
  attrs?: unknown;
  content?: unknown;
}

/**
 * ProseMirror の JSON から照合用の本文を作る。`prosemirrorToText` と同じ規則
 * （text node の文字、段落と見出しの終わりに `\n`）に、ルビの atom の `attrs.base` を足す。
 * mention などほかの atom は入れない。JSON が読めない・object でないときは null（呼出し側で body を使う）。
 */
function docJsonToMatchText(docJson: string): string | null {
  if (!docJson) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(docJson);
  } catch {
    return null;
  }
  if (!isNodeLike(doc)) return null;
  return walk(doc);
}

function isNodeLike(value: unknown): value is PmJsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(node: PmJsonNode): string {
  if (typeof node.text === "string" && node.text) return node.text;
  if (node.type === "ruby") {
    const base = isNodeLike(node.attrs)
      ? (node.attrs as { base?: unknown }).base
      : undefined;
    return typeof base === "string" ? base : "";
  }
  if (!Array.isArray(node.content)) return "";
  const inner = node.content
    .map((child) => (isNodeLike(child) ? walk(child) : ""))
    .join("");
  return node.type === "paragraph" || node.type === "heading"
    ? `${inner}\n`
    : inner;
}
