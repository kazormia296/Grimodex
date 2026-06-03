import type { Citation } from "./agent/agentTypes";

/**
 * Web 検索 (RAG) 引用の事後検証ユーティリティ（設計書 §0-3 / §6-1）。
 *
 * - `sanitizeCitations`: 構造化引用から不正 (非 http(s) / パース不能 / 重複) を排除。
 * - `findUnbackedUrls`: 回答本文中の URL を引用集合とファジー照合し、裏付けの
 *   ない（捏造の疑いがある）URL を返す。
 *
 * Phase 1 では検索取得自体はプロバイダのサーバ側で完結するため、構造化引用は
 * grounded（実在）である。本文中にモデルが書いた URL のみ捏造リスクがあるので、
 * そこをファジー照合で検出する。
 */

/** URL を比較用に正規化する（host から www. を除去、末尾スラッシュ/クエリ除去、小文字化）。 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * 2-gram Dice 係数による文字列類似度（0..1）。大小無視・空白圧縮。
 * 完全一致は 1、共通 bigram なしは 0。
 */
export function fuzzyRatio(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };

  const ma = bigrams(x);
  const mb = bigrams(y);
  let intersection = 0;
  let total = 0;
  for (const v of ma.values()) total += v;
  for (const [g, vb] of mb) {
    total += vb;
    intersection += Math.min(ma.get(g) ?? 0, vb);
  }
  return total === 0 ? 0 : (2 * intersection) / total;
}

/** URL の protocol を返す。パース不能なら null。 */
function urlProtocol(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** http(s) かつ非空の URL のみ残し、正規化 URL で重複排除する。 */
export function sanitizeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (!c.url) continue;
    // パース不能 (null) や非 http(s) URL は捏造/危険とみなし除外。
    const protocol = urlProtocol(c.url);
    if (protocol !== "https:" && protocol !== "http:") continue;
    const key = normalizeUrl(c.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * 回答本文中の http(s) URL のうち、引用集合に（正規化一致または fuzzy ≥
 * threshold で）裏付けられないものを返す。空配列なら全 URL が裏付けあり。
 */
export function findUnbackedUrls(
  answerText: string,
  citations: Citation[],
  threshold = 0.9,
): string[] {
  const urls = answerText.match(/https?:\/\/[^\s)<>"'`]+/g) ?? [];
  if (urls.length === 0) return [];
  const citNorms = citations.map((c) => normalizeUrl(c.url));
  const unbacked: string[] = [];
  for (const raw of urls) {
    const n = normalizeUrl(raw.replace(/[.,;)]+$/, ""));
    const backed = citNorms.some(
      (cn) => cn === n || fuzzyRatio(cn, n) >= threshold,
    );
    if (!backed && !unbacked.includes(raw)) unbacked.push(raw);
  }
  return unbacked;
}
