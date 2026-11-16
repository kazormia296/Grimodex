/**
 * アプリの使い方ヘルプ文書（判断の部分）の読み込み。
 *
 * 文書は ja だけで書く。人が読む画面は無く、Chat の agent が利用者の言語で答える
 * （設計書 §10.2 の 3）。コマンド・パネル・設定カテゴリの UI の名前とキーは文書に直書きせず、
 * `{{command:<id>}}` などの参照で書き、返すときに UI 言語のラベルと実際のキー割当へ展開する
 * （helpRefs.ts）。
 */

import editorFindReplaceDoc from "./topics/editor-find-replace.md?raw";
import editorSaveInlineAiDoc from "./topics/editor-save-inline-ai.md?raw";
import editorTabsSplitDoc from "./topics/editor-tabs-split.md?raw";
import layoutPanelsDoc from "./topics/layout-panels.md?raw";
import layoutPresetsDoc from "./topics/layout-presets.md?raw";
import phoneNavigationDoc from "./topics/phone-navigation.md?raw";
import settingsOpenDoc from "./topics/settings-open.md?raw";
import shortcutsCustomizeDoc from "./topics/shortcuts-customize.md?raw";

export interface HelpTopic {
  /** `topic:` を付ける前の id。例: `layout.presets` */
  id: string;
  /** 利用者の語彙で書いた質問の形の題 */
  title: string;
  keywords: string[];
  /** 参照を展開する前の本文（frontmatter を除く） */
  body: string;
  /** 本文中の `## 見出し`（1 見出し＝1 つの質問） */
  headings: string[];
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** frontmatter 付きの文書を解釈する。形式が崩れていれば例外を投げる（試験で検出する）。 */
export function parseHelpDoc(raw: string, source: string): HelpTopic {
  const match = FRONTMATTER.exec(raw);
  if (!match) throw new Error(`${source}: frontmatter がありません`);
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0)
      throw new Error(`${source}: frontmatter の行が不正: ${line}`);
    fields.set(
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim(),
    );
  }
  const id = fields.get("id");
  const title = fields.get("title");
  if (!id || !/^[A-Za-z][A-Za-z0-9.]*$/.test(id)) {
    throw new Error(`${source}: id が不正: ${id ?? "(なし)"}`);
  }
  if (!title) throw new Error(`${source}: title がありません`);
  const body = raw.slice(match[0].length).trim();
  if (!body) throw new Error(`${source}: 本文がありません`);
  const keywords = (fields.get("keywords") ?? "")
    .split(/[,、]/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const headings = [...body.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  return { id, title, keywords, body, headings };
}

const RAW_DOCS: Record<string, string> = {
  "./topics/editor-find-replace.md": editorFindReplaceDoc,
  "./topics/editor-save-inline-ai.md": editorSaveInlineAiDoc,
  "./topics/editor-tabs-split.md": editorTabsSplitDoc,
  "./topics/layout-panels.md": layoutPanelsDoc,
  "./topics/layout-presets.md": layoutPresetsDoc,
  "./topics/phone-navigation.md": phoneNavigationDoc,
  "./topics/settings-open.md": settingsOpenDoc,
  "./topics/shortcuts-customize.md": shortcutsCustomizeDoc,
};

let topicsCache: HelpTopic[] | null = null;

/** bundle に入っている全ヘルプ文書（id 順）。 */
export function getHelpTopics(): HelpTopic[] {
  if (topicsCache === null) {
    const topics = Object.entries(RAW_DOCS)
      .map(([source, raw]) => parseHelpDoc(raw, source))
      .sort((a, b) => a.id.localeCompare(b.id));
    const seen = new Set<string>();
    for (const topic of topics) {
      if (seen.has(topic.id))
        throw new Error(`ヘルプ文書の id が重複: ${topic.id}`);
      seen.add(topic.id);
    }
    topicsCache = topics;
  }
  return topicsCache;
}
