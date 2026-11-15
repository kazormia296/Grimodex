/**
 * アプリの使い方ヘルプの索引と詳細。実行時に次の 3 つを合わせて作る（設計書 §4.4）。
 *
 *  1. コマンド（keybindings.ts の getCommands()。説明は locales の help.commands.<id>）
 *  2. パネルと設定カテゴリ（PanelId／SETTINGS_CATEGORIES）
 *  3. ヘルプ文書（src/help/topics。参照を展開して返す）
 *
 * 設定の値は返さない。書いていないことは「無い」と答えるため、存在しない ID は null を返す。
 */
import i18next from "@/lib/i18n";
import { AGENT_SETTING_CATALOG } from "@/../electron/shared/agentSettingCatalog";
import type { PanelId } from "@/features/layout/panelIds";
import { getHelpTopics, type HelpTopic } from "./helpDocs";
import {
  collectRefs,
  expandRefs,
  findMalformedRefs,
  type HelpRef,
} from "./helpRefs";
import {
  allCommandIds,
  allPanelIds,
  builtinPresetName,
  commandFacts,
  currentOs,
  focusCommandOfPanel,
  panelTitle,
  settingsCategoryList,
  type HelpCommandFacts,
} from "./helpCatalog";
import { readUiState } from "./uiState";

export type HelpKind = "command" | "panel" | "settingsCategory" | "topic";

export interface HelpIndexItem {
  /** 種類の接頭辞付き。`command:<id>`／`panel:<id>`／`settings:<id>`／`topic:<id>` */
  id: string;
  title: string;
  kind: HelpKind;
}

export const HELP_KINDS: readonly HelpKind[] = [
  "command",
  "panel",
  "settingsCategory",
  "topic",
];

const ID_PREFIX: Record<HelpKind, string> = {
  command: "command",
  panel: "panel",
  settingsCategory: "settings",
  topic: "topic",
};

function entryId(kind: HelpKind, key: string): string {
  return `${ID_PREFIX[kind]}:${key}`;
}

function parseEntryId(id: string): { kind: HelpKind; key: string } | null {
  const separator = id.indexOf(":");
  if (separator <= 0) return null;
  const prefix = id.slice(0, separator);
  const kind = HELP_KINDS.find((candidate) => ID_PREFIX[candidate] === prefix);
  const key = id.slice(separator + 1);
  return kind && key ? { kind, key } : null;
}

// ── 参照の展開 ───────────────────────────────────────────────────────────

function describeCommand(facts: HelpCommandFacts): string {
  if (!facts.availableOnThisOS) {
    return `「${facts.label}」（${i18next.t("help.macUnavailable")}）`;
  }
  return `「${facts.label}」（${facts.display ?? i18next.t("help.unbound")}）`;
}

function resolveRef(ref: HelpRef): string | null {
  switch (ref.kind) {
    case "command": {
      const facts = commandFacts(ref.key);
      return facts ? describeCommand(facts) : null;
    }
    case "panel":
      return allPanelIds().includes(ref.key as PanelId)
        ? `「${panelTitle(ref.key as PanelId)}」`
        : null;
    case "settings": {
      const category = settingsCategoryList().find((c) => c.id === ref.key);
      return category
        ? i18next.t("help.settingsCategoryRef", { category: category.label })
        : null;
    }
    case "preset": {
      const name = builtinPresetName(ref.key);
      return name ? `「${name}」` : null;
    }
    case "t":
      return i18next.exists(ref.key) ? i18next.t(ref.key) : null;
  }
}

/** 文書の参照が実在しない・綴りが誤っているものを返す（試験用）。空なら正常。 */
export function findBrokenRefs(body: string): string[] {
  const broken = findMalformedRefs(body);
  for (const ref of collectRefs(body)) {
    if (ref.kind === "t") {
      if (!i18next.exists(ref.key, { lng: "ja" })) broken.push(ref.raw);
    } else if (resolveRef(ref) === null) {
      broken.push(ref.raw);
    }
  }
  return broken;
}

function relatedIds(topic: HelpTopic): string[] {
  const ids = new Set<string>();
  for (const ref of collectRefs(topic.body)) {
    if (ref.kind === "command") ids.add(entryId("command", ref.key));
    if (ref.kind === "panel") ids.add(entryId("panel", ref.key));
    if (ref.kind === "settings") ids.add(entryId("settingsCategory", ref.key));
  }
  return [...ids];
}

// ── 索引と検索 ───────────────────────────────────────────────────────────

interface IndexEntry extends HelpIndexItem {
  /** 題・id・keywords など、強い手がかり */
  haystack: string;
  /** 文書の本文（参照展開後）。題・keywords より弱い手がかりとして使う */
  bodyHaystack: string;
}

/** 本文だけに当たった語の重み（題・keywords に当たった語を 1 とする）。 */
const BODY_MATCH_FACTOR = 0.4;

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

function jaText(key: string): string {
  return i18next.exists(key, { lng: "ja" })
    ? i18next.t(key, { lng: "ja" })
    : "";
}

function buildEntries(): IndexEntry[] {
  const entries: IndexEntry[] = [];
  for (const topic of getHelpTopics()) {
    entries.push({
      id: entryId("topic", topic.id),
      title: topic.title,
      kind: "topic",
      haystack: normalize(
        [topic.id, topic.title, ...topic.keywords, ...topic.headings].join(" "),
      ),
      bodyHaystack: normalize(expandRefs(topic.body, resolveRef)),
    });
  }
  for (const category of settingsCategoryList()) {
    entries.push({
      id: entryId("settingsCategory", category.id),
      title: category.label,
      kind: "settingsCategory",
      haystack: normalize(`${category.id} ${category.label}`),
      bodyHaystack: "",
    });
  }
  for (const id of allPanelIds()) {
    const title = panelTitle(id);
    entries.push({
      id: entryId("panel", id),
      title,
      kind: "panel",
      haystack: normalize(`${id} ${title} ${jaText(`layout.panel.${id}`)}`),
      bodyHaystack: "",
    });
  }
  for (const id of allCommandIds()) {
    const facts = commandFacts(id);
    if (!facts) continue;
    entries.push({
      id: entryId("command", id),
      title: facts.label,
      kind: "command",
      haystack: normalize(
        [
          id,
          facts.label,
          facts.description ?? "",
          jaText(`keys.${id}`),
          facts.display ?? "",
          facts.defaultBinding,
        ].join(" "),
      ),
      bodyHaystack: "",
    });
  }
  return entries;
}

const HIRAGANA = /^[ぁ-ゟ]$/;
const MAX_QUERY_RESULTS = 25;
/** 検索語そのものの一致の重み（2 文字の組は 1）。 */
const WHOLE_TOKEN_WEIGHT = 3;
/** 2 文字の組が当たる項目は、組の総数のこの割合以上（ただし 2 組以上）が当たること。 */
const PAIR_MATCH_RATIO = 0.5;
/** 先頭の項目の点の何割に満たないものを外すか。 */
const RELATIVE_CUTOFF = 0.35;

/** 検索語を (語, 重み) に分ける。長い語は日本語の自然文でも当たるよう 2 文字の組も使う。 */
function queryTerms(query: string): Array<{ term: string; weight: number }> {
  const terms = new Map<string, number>();
  for (const token of normalize(query)
    .split(/[\s、，,。.?？!！「」『』（）()「」・/]+/)
    .filter(Boolean)) {
    terms.set(token, Math.max(terms.get(token) ?? 0, WHOLE_TOKEN_WEIGHT));
    if (token.length >= 3) {
      for (let i = 0; i + 2 <= token.length; i++) {
        const pair = token.slice(i, i + 2);
        // ひらがなを含む組（する・には・を開 等）は助詞や語尾で、どの項目にも当たるので使わない。
        if ([...pair].some((ch) => HIRAGANA.test(ch))) continue;
        // ASCII 語の途中の切れ端（"ab" 等）は誤爆するので使わない。
        if (/^[\x20-\x7e]+$/.test(pair)) continue;
        if (!terms.has(pair)) terms.set(pair, 1);
      }
    }
  }
  return [...terms].map(([term, weight]) => ({ term, weight }));
}

export interface HelpIndexResult {
  /** 条件に合う件数（items は多いとき先頭から切る） */
  total: number;
  items: HelpIndexItem[];
}

export function listHelpIndex(
  options: { query?: string; kind?: HelpKind } = {},
): HelpIndexResult {
  const all = buildEntries();
  const entries = options.kind
    ? all.filter((entry) => entry.kind === options.kind)
    : all;
  const toItem = ({ id, title, kind }: IndexEntry): HelpIndexItem => ({
    id,
    title,
    kind,
  });
  const query = options.query?.trim();
  if (!query) return { total: entries.length, items: entries.map(toItem) };

  // 語ごとに、当たる項目が少ないほど重く数える（どこにでもある語で順位が決まらないように）。
  const terms = queryTerms(query).map(({ term, weight }) => {
    const df = all.filter(
      (entry) =>
        entry.haystack.includes(term) || entry.bodyHaystack.includes(term),
    ).length;
    return {
      term,
      weight: df === 0 ? 0 : weight * Math.log(1 + all.length / df),
      whole: weight === WHOLE_TOKEN_WEIGHT,
    };
  });
  const pairCount = terms.filter((t) => !t.whole).length;
  // 語そのものが当たるか、2 文字の組が 2 つ以上、かつ組の総数の半分以上当たること
  // （「ーン」だけが「シーン」に当たる、のような少数の偶然の一致は載せない）。
  // 組が 1 つしかない問い合わせは 1 つで足りる。
  const requiredPairs = Math.min(
    pairCount,
    Math.max(2, Math.ceil(pairCount * PAIR_MATCH_RATIO)),
  );
  const scored = entries
    .map((entry, order) => {
      let score = 0;
      let wholeHit = false;
      let pairHits = 0;
      for (const { term, weight, whole } of terms) {
        const inHaystack = entry.haystack.includes(term);
        if (!inHaystack && !entry.bodyHaystack.includes(term)) continue;
        score += inHaystack ? weight : weight * BODY_MATCH_FACTOR;
        if (whole) wholeHit = true;
        else pairHits += 1;
      }
      return {
        entry,
        order,
        score,
        passes: wholeHit || pairHits >= requiredPairs,
      };
    })
    .filter((row) => row.passes && row.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);
  // 先頭の項目よりずっと低いものは、偶然の一致として載せない。
  const top = scored[0]?.score ?? 0;
  const kept = scored.filter((row) => row.score >= top * RELATIVE_CUTOFF);
  return {
    total: kept.length,
    items: kept.slice(0, MAX_QUERY_RESULTS).map(({ entry }) => toItem(entry)),
  };
}

/** 存在しない id への案内用。近い項目を最大 5 件返す（綴りの誤りは末尾を削って探す）。 */
export function suggestHelpIds(id: string): HelpIndexItem[] {
  const key = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  const candidates = [key, key.slice(0, -1), key.slice(0, -2)].filter(
    (candidate) => candidate.length >= 3,
  );
  for (const query of candidates) {
    const { items } = listHelpIndex({ query });
    if (items.length > 0) return items.slice(0, 5);
  }
  return [];
}

// ── 詳細 ─────────────────────────────────────────────────────────────────

function shortcutOf(commandId: string): Record<string, unknown> | null {
  const facts = commandFacts(commandId);
  if (!facts) return null;
  return {
    id: entryId("command", facts.id),
    title: facts.label,
    keys: facts.display,
    availableOnThisOS: facts.availableOnThisOS,
  };
}

/**
 * agent が変更を提案できる設定（設定の目録）。key・label・型・範囲だけで、現在値は返さない。
 * 提案は propose_setting_change で行い、適用は利用者がカードで行う。
 */
function proposableSettingsOf(categoryId: string): {
  proposableSettings?: Array<{
    key: string;
    label: string;
    type: string;
    range?: { min: number; max: number; step: number };
  }>;
  proposeWith?: string;
} {
  const entries = AGENT_SETTING_CATALOG.filter(
    (entry) => entry.categoryId === categoryId,
  );
  if (entries.length === 0) return {};
  return {
    proposableSettings: entries.map((entry) => ({
      key: entry.key,
      label: i18next.t(entry.labelKey),
      type: entry.type,
      ...(entry.range
        ? {
            range: {
              min: entry.range.min,
              max: entry.range.max,
              step: entry.range.step,
            },
          }
        : {}),
    })),
    proposeWith: "propose_setting_change",
  };
}

/** 1 項目の詳細。存在しない id は null。設定の値は返さない。 */
export function getHelpDetail(id: string): Record<string, unknown> | null {
  const parsed = parseEntryId(id);
  if (!parsed) return null;
  const { kind, key } = parsed;

  if (kind === "command") {
    const facts = commandFacts(key);
    if (!facts) return null;
    const panel = facts.panel
      ? { id: entryId("panel", facts.panel), title: panelTitle(facts.panel) }
      : null;
    return {
      id,
      kind,
      title: facts.label,
      description: facts.description,
      // 今の OS で使えないコマンドは、キーを返さない（案内してしまわないように）。
      keys: facts.availableOnThisOS ? facts.display : null,
      defaultKeys: facts.availableOnThisOS ? facts.defaultDisplay : null,
      customized: facts.customized,
      os: currentOs(),
      availableOnThisOS: facts.availableOnThisOS,
      ...(facts.macUnavailable && !facts.availableOnThisOS
        ? { note: i18next.t("help.macUnavailable") }
        : {}),
      ...(panel ? { panel } : {}),
    };
  }

  if (kind === "panel") {
    if (!allPanelIds().includes(key as PanelId)) return null;
    const panelId = key as PanelId;
    const focusCommand = focusCommandOfPanel(panelId);
    const state = readUiState();
    return {
      id,
      kind,
      title: panelTitle(panelId),
      open:
        state.openPanels === null
          ? null
          : state.openPanels.some((panel) => panel.id === panelId),
      shortcut: focusCommand ? shortcutOf(focusCommand) : null,
    };
  }

  if (kind === "settingsCategory") {
    const category = settingsCategoryList().find((c) => c.id === key);
    if (!category) return null;
    const openSettings = commandFacts("openSettings");
    const shortcut = openSettings?.display ?? null;
    return {
      id,
      kind,
      title: category.label,
      howToOpen: shortcut
        ? i18next.t("help.settingsOpenGuide", {
            category: category.label,
            shortcut,
          })
        : i18next.t("help.settingsOpenGuideNoShortcut", {
            category: category.label,
          }),
      note: "Setting values are not available through this tool. Guide the user to the settings screen instead of guessing a value.",
      ...proposableSettingsOf(category.id),
    };
  }

  const topic = getHelpTopics().find((candidate) => candidate.id === key);
  if (!topic) return null;
  return {
    id,
    kind,
    title: topic.title,
    body: expandRefs(topic.body, resolveRef),
    related: relatedIds(topic),
  };
}
