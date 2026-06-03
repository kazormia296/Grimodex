import type { WebSearchConfig } from "./agent/agentTypes";

/**
 * Web 検索 (RAG) Phase 2「制御強化」のポリシー組み立て（純関数）。
 *
 * 永続設定 (settingsStore の `ai.webSearch.*`) の生値を正規化し、RAG ターンで
 * Rust へ渡す {@link WebSearchConfig} を組み立てる。ドメイン制御 (allowlist /
 * blocklist) と content token 上限を載せる。
 *
 * - ドメイン allowlist / blocklist は **排他**（allow 優先）。Anthropic native
 *   web_search は両方同時指定不可、OpenRouter(exa) も Firecrawl 系で排他のため、
 *   ソース段階で片方に倒しておく。
 * - `maxContentTokens` は OpenRouter(exa) 専用。Anthropic 側には対応フィールドが
 *   無いため Rust の Anthropic 経路では無視される（ここでは値だけ運ぶ）。
 */

export type WebSearchDomainMode = "off" | "allow" | "block";

export interface WebSearchControls {
  /** ドメインフィルタの種別。off=フィルタなし。 */
  domainMode: WebSearchDomainMode;
  /** mode に応じた対象ドメイン（正規化済み）。 */
  domains: string[];
  /** OpenRouter(exa) の 1 ページ content token 上限（未指定 = プロバイダ既定）。 */
  maxContentTokens?: number;
}

/**
 * ドメイン 1 件を正規化する（trim / scheme 除去 / 末尾スラッシュ除去）。
 * 設定 UI の保存時と RAG ターンの組み立て時で同じ正規化を使い、表示と実際に
 * 送る値の乖離を防ぐ。
 */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
}

/** 文字列配列を正規化し、空要素除去・重複排除した配列を返す。 */
export function normalizeDomainList(raw: string[]): string[] {
  return [...new Set(raw.map(normalizeDomain).filter((d) => d.length > 0))];
}

/**
 * settingsStore の生文字列値から {@link WebSearchControls} を組み立てる。
 * 不正な JSON / 非配列 / 非正の数値は安全側（空 / undefined）に倒す。
 */
export function parseWebSearchControls(input: {
  domainMode?: string;
  domainsJson?: string;
  maxContentTokensRaw?: string;
}): WebSearchControls {
  const domainMode: WebSearchDomainMode =
    input.domainMode === "allow" || input.domainMode === "block"
      ? input.domainMode
      : "off";

  let domains: string[] = [];
  try {
    const parsed: unknown = JSON.parse(input.domainsJson ?? "[]");
    if (Array.isArray(parsed)) {
      domains = normalizeDomainList(
        parsed.filter((d): d is string => typeof d === "string"),
      );
    }
  } catch {
    domains = [];
  }

  const n = Number(input.maxContentTokensRaw);
  const maxContentTokens =
    Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

  return { domainMode, domains, maxContentTokens };
}

/**
 * RAG ターンの {@link WebSearchConfig}（Rust wire 形）を組み立てる。
 * `ragActive` が false なら検索を注入しない（null）。
 */
export function buildWebSearchConfig(
  ragActive: boolean,
  agentic: boolean,
  controls: WebSearchControls,
): WebSearchConfig | null {
  if (!ragActive) return null;

  const cfg: WebSearchConfig = {
    enabled: true,
    agentic,
    maxResults: 5,
    maxUses: 3,
  };

  // 排他: allow 優先。mode に対応する domains が空ならフィルタを付けない。
  if (controls.domainMode === "allow" && controls.domains.length > 0) {
    cfg.allowedDomains = controls.domains;
  } else if (controls.domainMode === "block" && controls.domains.length > 0) {
    cfg.blockedDomains = controls.domains;
  }

  if (controls.maxContentTokens && controls.maxContentTokens > 0) {
    cfg.maxContentTokens = controls.maxContentTokens;
  }

  return cfg;
}
