import type { AiModel, AiProvider } from "./types";
import { AI_PROVIDERS, modelDeveloper } from "./types";
import { overrideApiVariantForProvider } from "./aiNovelist";

/**
 * チャット入力欄のモデルピッカー(複数プロバイダ横断)で使う純ロジック。
 * UI 非依存 — プロバイダ別のモデル一覧を「セクション(プロバイダ見出し)」へ整列し、
 * 検索フィルタを掛けるだけ。表示ラベルの解決(i18n)とレンダリングは呼び出し側。
 */

/** ピッカー 1 行分のモデル。 */
export interface CatalogModel {
  id: string;
  name: string;
  provider: AiProvider;
  /**
   * 送信時に渡す解決済み API 経路(variant)。null = backend 既定解決。
   * 別プロバイダ選択時はこの値を chatModelVariantOverride として持たせる
   * (active provider の models 一覧に依存させない)。
   */
  variant: string | null;
  /**
   * OpenAI 互換: このモデルが属するエンドポイント id（他プロバイダは undefined）。
   * 選択時に chatEndpointIdOverride として持たせ、送信先 base_url / API キーを切り替える。
   */
  endpointId?: string;
}

/** プロバイダ(OpenAI 互換はエンドポイント) 1 つ分のセクション(見出し + モデル列)。 */
export interface CatalogSection {
  provider: AiProvider;
  models: CatalogModel[];
  /** OpenAI 互換のエンドポイント別セクション識別子（他プロバイダは undefined）。 */
  endpointId?: string;
  /** セクション見出しに併記するエンドポイントラベル（他プロバイダは undefined）。 */
  endpointLabel?: string;
}

/** buildModelCatalog の 1 入力エントリ。OpenAI 互換は 1 エンドポイント = 1 エントリ。 */
export interface CatalogProviderInput {
  provider: AiProvider;
  models: AiModel[];
  /** OpenAI 互換: このエントリのエンドポイント id。 */
  endpointId?: string;
  /** OpenAI 互換: エンドポイントの表示ラベル。 */
  endpointLabel?: string;
  /** OpenAI 互換: エンドポイント既定の variant（未指定なら overrideApiVariantForProvider）。 */
  variant?: string | null;
}

/**
 * 1 エントリ分の AiModel[] を CatalogModel[] へ変換する。
 * variant は別プロバイダ送信で「明示が必要な経路」のみ持たせる
 * (overrideApiVariantForProvider: sakana=responses / 他=null=backend 既定解決)。
 * OpenAI 互換はエンドポイント既定 variant を opts.variant で受け取り、endpointId を付ける。
 * 注意: resolveModelApiVariant は persisted 無しだと任意モデルに "legacy" を返すため
 * 別プロバイダ送信には使えない(sakana が legacy に化け、ai のべりすと以外も legacy 化する)。
 */
function toCatalogModels(
  provider: AiProvider,
  models: AiModel[],
  opts?: { endpointId?: string; variant?: string | null },
): CatalogModel[] {
  const variant =
    opts?.variant !== undefined
      ? opts.variant
      : overrideApiVariantForProvider(provider);
  return models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    provider,
    variant,
    endpointId: opts?.endpointId,
  }));
}

/**
 * プロバイダ別モデル一覧を整列されたセクション配列にする。
 * - active プロバイダのセクションを先頭に置く(現在の文脈を最優先で見せる)。
 * - OpenAI 互換は 1 エンドポイント = 1 セクション。active エンドポイントを互換内の先頭に置く。
 * - 残りは AI_PROVIDERS の定義順。
 * - モデルが 0 件のエントリはセクションごと落とす(空見出しを出さない)。
 * - 同一キー(provider、互換は provider:endpointId)が複数来たら最初の非空を採用(冪等)。
 */
export function buildModelCatalog(input: {
  activeProvider: AiProvider;
  activeEndpointId?: string | null;
  providerModels: CatalogProviderInput[];
}): CatalogSection[] {
  const { activeProvider, activeEndpointId, providerModels } = input;

  const keyOf = (e: CatalogProviderInput): string =>
    e.provider === "openai-compatible"
      ? `oc:${e.endpointId ?? ""}`
      : e.provider;

  const seen = new Set<string>();
  const byProvider = new Map<AiProvider, CatalogProviderInput[]>();
  for (const entry of providerModels) {
    if (entry.models.length === 0) continue;
    const key = keyOf(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider)!.push(entry);
  }

  // OpenAI 互換セクション内は active エンドポイントを先頭に。
  const ocList = byProvider.get("openai-compatible");
  if (ocList && activeEndpointId) {
    ocList.sort((a, b) => {
      const aRank = a.endpointId === activeEndpointId ? 0 : 1;
      const bRank = b.endpointId === activeEndpointId ? 0 : 1;
      return aRank - bRank;
    });
  }

  const order: AiProvider[] = [
    activeProvider,
    ...AI_PROVIDERS.filter((p) => p !== activeProvider),
  ];

  const sections: CatalogSection[] = [];
  for (const provider of order) {
    const entries = byProvider.get(provider);
    if (!entries) continue;
    for (const e of entries) {
      sections.push({
        provider: e.provider,
        endpointId: e.endpointId,
        endpointLabel: e.endpointLabel,
        models: toCatalogModels(e.provider, e.models, {
          endpointId: e.endpointId,
          variant: e.variant,
        }),
      });
    }
  }
  return sections;
}

/**
 * 1 セクション分のモデルをデベロッパー(モデル ID のスラッシュ前)でサブグループ化する。
 * OpenRouter のように 1 プロバイダ内に多数のデベロッパーが混在する場合の二段表示用。
 * groupModelsByDeveloper(types) の CatalogModel 版(variant/provider を型保持する)。
 * 戻り値: [developerLabel, CatalogModel[]] のタプル配列(デベロッパー名昇順・空は末尾)。
 */
export function groupCatalogByDeveloper(
  models: CatalogModel[],
): [string, CatalogModel[]][] {
  const map = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const dev = modelDeveloper(m.id);
    if (!map.has(dev)) map.set(dev, []);
    map.get(dev)!.push(m);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...map.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
}

/**
 * セクション群を検索クエリで絞る。クエリはモデル名 / モデル ID に対する
 * 部分一致(大文字小文字無視)。マッチが 0 件のセクションは落とす。
 * 空クエリはそのまま返す。
 */
export function filterCatalog(
  sections: CatalogSection[],
  query: string,
): CatalogSection[] {
  const q = query.trim().toLowerCase();
  if (!q) return sections;
  const out: CatalogSection[] = [];
  for (const section of sections) {
    const models = section.models.filter(
      (m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
    if (models.length > 0) out.push({ ...section, models });
  }
  return out;
}

/**
 * 1 プロバイダ分のモデルを whitelist で絞る。
 *
 * `ai.modelWhitelist` の保存先は全プロバイダ共通だが、設定 UI でチェックできるのは
 * その時点のアクティブプロバイダだけ。したがって、このモデル集合に 1 件でも一致する
 * id がある場合だけ絞り込み、一致がなければ「このプロバイダでは未選択」として全件を
 * 返す。ローカルモデルの選択がクラウドプロバイダを丸ごと隠すことを防ぐ。
 */
export function applyModelWhitelistToModels<T extends { id: string }>(
  models: T[],
  whitelist: string[],
): T[] {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return models;
  const allow = new Set(whitelist);
  const matched = models.filter((model) => allow.has(model.id));
  return matched.length > 0 ? matched : models;
}

/**
 * グローバル保存された whitelist を、各プロバイダ／エンドポイントのセクション内で
 * 相対的に適用する。セクション内にチェック済みモデルがあればそのモデルだけを表示し、
 * 一致がなければそのセクションは全件表示する。
 */
export function applyModelWhitelist(
  sections: CatalogSection[],
  whitelist: string[],
): CatalogSection[] {
  if (whitelist.length === 0) return sections;
  return sections.map((section) => {
    const models = applyModelWhitelistToModels(section.models, whitelist);
    return models === section.models ? section : { ...section, models };
  });
}
