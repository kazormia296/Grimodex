import { describe, it, expect, beforeEach } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parseNovelcrafterZip } from "./novelcrafterParser";

// ─────────────────────────────────────────────────────────────────
// Helpers to build fake zip bytes
// ─────────────────────────────────────────────────────────────────

function makeZip(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    input[path] = strToU8(content);
  }
  return zipSync(input);
}

const NOVEL_MD = `# テスト小説
by テスト著者`;

const CHARACTER_METADATA = JSON.stringify({
  id: "NC_CHAR_001",
  attributes: {
    type: "character",
    name: "アリス",
    color: null,
    aliases: ["Alice", "アリちゃん"],
    tags: ["Main Character"],
    alwaysIncludeInContext: true,
    doNotTrack: false,
    noAutoInclude: false,
  },
  relationships: { nestedEntries: [] },
  links: { externalReferences: [] },
});

const CHARACTER_ENTRY = `---
type: character
name: アリス
color: null
aliases:
  - Alice
  - アリちゃん
tags:
  - Main Character
alwaysIncludeInContext: true
doNotTrack: false
noAutoInclude: false
fields:
  経歴: |-
    幼少期は農村で育つ。

    20歳で都市へ移住。
  特技: |-
    料理・剣術
---
金髪の少女。正義感が強い。`;

const LOCATION_METADATA = JSON.stringify({
  id: "NC_LOC_001",
  attributes: {
    type: "location",
    name: "王都",
    color: null,
    aliases: [],
    tags: [],
    alwaysIncludeInContext: false,
    doNotTrack: false,
    noAutoInclude: false,
  },
  relationships: { nestedEntries: [] },
  links: { externalReferences: [] },
});

const LOCATION_ENTRY = `---
type: location
name: 王都
color: null
aliases: []
tags: []
alwaysIncludeInContext: false
doNotTrack: false
noAutoInclude: false
fields: {}
---
帝国の首都。人口百万人を超える大都市。`;

const OBJECT_METADATA = JSON.stringify({
  id: "NC_OBJ_001",
  attributes: {
    type: "object",
    name: "魔法の剣",
    color: null,
    aliases: ["聖剣"],
    tags: ["武器"],
    alwaysIncludeInContext: false,
    doNotTrack: true,
    noAutoInclude: false,
  },
  relationships: { nestedEntries: [] },
  links: { externalReferences: [] },
});

const OBJECT_ENTRY = `---
type: object
name: 魔法の剣
color: null
aliases:
  - 聖剣
tags:
  - 武器
alwaysIncludeInContext: false
doNotTrack: true
noAutoInclude: false
fields: {}
---
古代に鍛えられた伝説の剣。`;

const LORE_PARENT_METADATA = JSON.stringify({
  id: "NC_LORE_PARENT",
  attributes: {
    type: "lore",
    name: "魔法体系",
    color: null,
    aliases: [],
    tags: [],
    alwaysIncludeInContext: false,
    doNotTrack: false,
    noAutoInclude: false,
  },
  relationships: { nestedEntries: ["NC_LORE_CHILD"] },
  links: { externalReferences: [] },
});

const LORE_PARENT_ENTRY = `---
type: lore
name: 魔法体系
fields: {}
---
この世界の魔法に関するルール。`;

const LORE_CHILD_METADATA = JSON.stringify({
  id: "NC_LORE_CHILD",
  attributes: {
    type: "lore",
    name: "炎魔法",
    color: null,
    aliases: [],
    tags: [],
    alwaysIncludeInContext: false,
    doNotTrack: false,
    noAutoInclude: false,
  },
  relationships: { nestedEntries: [] },
  links: { externalReferences: [] },
});

const LORE_CHILD_ENTRY = `---
type: lore
name: 炎魔法
fields: {}
---
炎を操る魔法。`;

const SNIPPET_CONTENT = `---
title: 世界観メモ
favourite: false
---
# 世界観メモ

この世界では魔法が一般的に使われている。

## 社会構造

三つの帝国が覇権を競っている。`;

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe("parseNovelcrafterZip", () => {
  describe("project title", () => {
    it("extracts title from novel.md", () => {
      const zip = makeZip({ "novel.md": NOVEL_MD });
      const result = parseNovelcrafterZip(zip);
      expect(result.projectTitle).toBe("テスト小説");
    });

    it("uses fallback title when novel.md is missing", () => {
      const zip = makeZip({});
      const result = parseNovelcrafterZip(zip);
      expect(result.projectTitle).toBe("Imported Project");
    });
  });

  describe("codex entries — character", () => {
    let zip: Uint8Array;
    beforeEach(() => {
      zip = makeZip({
        "novel.md": NOVEL_MD,
        "characters/alice-NC_CHAR_001/metadata.json": CHARACTER_METADATA,
        "characters/alice-NC_CHAR_001/entry.md": CHARACTER_ENTRY,
      });
    });

    it("parses character name and type", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries).toHaveLength(1);
      expect(codexEntries[0].name).toBe("アリス");
      expect(codexEntries[0].type).toBe("character");
    });

    it("parses aliases", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].aliases).toEqual(["Alice", "アリちゃん"]);
    });

    it("uses body after frontmatter as summary", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].summary).toBe("金髪の少女。正義感が強い。");
    });

    it("sets contextMode=always when alwaysIncludeInContext=true", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].contextMode).toBe("always");
    });

    it("includes tags in tagsCache", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      const tags = JSON.parse(codexEntries[0].tagsCache);
      expect(tags).toContainEqual({ name: "Main Character", color: null });
    });

    it("stores ncId for parent resolution", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].ncId).toBe("NC_CHAR_001");
    });

    it("assigns a valid UUID as id", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores raw fields for custom detail import", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].fields).toEqual({
        経歴: "幼少期は農村で育つ。\n\n20歳で都市へ移住。",
        特技: "料理・剣術",
      });
      // content is always "{}" — fields go to codexDetailValues, not body editor
      expect(codexEntries[0].content).toBe("{}");
    });
  });

  describe("codex entries — location", () => {
    it("parses location type correctly", () => {
      const zip = makeZip({
        "locations/ōto-NC_LOC_001/metadata.json": LOCATION_METADATA,
        "locations/ōto-NC_LOC_001/entry.md": LOCATION_ENTRY,
      });
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].type).toBe("location");
      expect(codexEntries[0].summary).toBe(
        "帝国の首都。人口百万人を超える大都市。",
      );
    });
  });

  describe("codex entries — object (→ item)", () => {
    it("maps object type to item", () => {
      const zip = makeZip({
        "objects/sword-NC_OBJ_001/metadata.json": OBJECT_METADATA,
        "objects/sword-NC_OBJ_001/entry.md": OBJECT_ENTRY,
      });
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].type).toBe("item");
    });

    it("sets contextMode=hidden when doNotTrack=true", () => {
      const zip = makeZip({
        "objects/sword-NC_OBJ_001/metadata.json": OBJECT_METADATA,
        "objects/sword-NC_OBJ_001/entry.md": OBJECT_ENTRY,
      });
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].contextMode).toBe("hidden");
    });
  });

  describe("codex entries — lore parent/child", () => {
    let zip: Uint8Array;
    beforeEach(() => {
      zip = makeZip({
        "lore/magic-NC_LORE_PARENT/metadata.json": LORE_PARENT_METADATA,
        "lore/magic-NC_LORE_PARENT/entry.md": LORE_PARENT_ENTRY,
        "lore/fire-NC_LORE_CHILD/metadata.json": LORE_CHILD_METADATA,
        "lore/fire-NC_LORE_CHILD/entry.md": LORE_CHILD_ENTRY,
      });
    });

    it("resolves parentId for nested entries", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      const parent = codexEntries.find((e) => e.ncId === "NC_LORE_PARENT");
      const child = codexEntries.find((e) => e.ncId === "NC_LORE_CHILD");
      expect(parent).toBeDefined();
      expect(child).toBeDefined();
      expect(child!.parentId).toBe(parent!.id);
    });

    it("leaves parentId undefined for top-level entries", () => {
      const { codexEntries } = parseNovelcrafterZip(zip);
      const parent = codexEntries.find((e) => e.ncId === "NC_LORE_PARENT");
      expect(parent!.parentId).toBeUndefined();
    });
  });

  describe("codex entries — other (→ lore)", () => {
    it("maps other type to lore", () => {
      const otherMeta = JSON.stringify({
        id: "NC_OTHER_001",
        attributes: {
          type: "other",
          name: "ジャンル",
          color: "gray",
          aliases: [],
          tags: [],
          alwaysIncludeInContext: false,
          doNotTrack: false,
          noAutoInclude: false,
        },
        relationships: { nestedEntries: [] },
        links: { externalReferences: [] },
      });
      const otherEntry = `---
type: other
name: ジャンル
fields: {}
---
SF・ファンタジー`;
      const zip = makeZip({
        "other/genre-NC_OTHER_001/metadata.json": otherMeta,
        "other/genre-NC_OTHER_001/entry.md": otherEntry,
      });
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].type).toBe("lore");
    });
  });

  describe("snippets", () => {
    let zip: Uint8Array;
    beforeEach(() => {
      zip = makeZip({
        "novel.md": NOVEL_MD,
        "snippets/2026-03-09 世界観メモ - 3Ai0BDwM.md": SNIPPET_CONTENT,
      });
    });

    it("parses snippet title from frontmatter", () => {
      const { snippets } = parseNovelcrafterZip(zip);
      expect(snippets).toHaveLength(1);
      expect(snippets[0].title).toBe("世界観メモ");
    });

    it("stores markdown body as snippet content", () => {
      const { snippets } = parseNovelcrafterZip(zip);
      expect(snippets[0].content).toContain("# 世界観メモ");
      expect(snippets[0].content).toContain("三つの帝国が覇権を競っている。");
    });

    it("extracts ncId from filename", () => {
      const { snippets } = parseNovelcrafterZip(zip);
      expect(snippets[0].ncId).toBe("3Ai0BDwM");
    });

    it("assigns a valid UUID as id", () => {
      const { snippets } = parseNovelcrafterZip(zip);
      expect(snippets[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("empty zip", () => {
    it("returns empty arrays for empty zip", () => {
      const zip = makeZip({});
      const result = parseNovelcrafterZip(zip);
      expect(result.codexEntries).toHaveLength(0);
      expect(result.snippets).toHaveLength(0);
    });
  });

  describe("entry without fields", () => {
    it("stores empty content when no fields", () => {
      const meta = JSON.stringify({
        id: "NC_NO_FIELDS",
        attributes: {
          type: "lore",
          name: "シンプルロア",
          color: null,
          aliases: [],
          tags: [],
          alwaysIncludeInContext: false,
          doNotTrack: false,
          noAutoInclude: false,
        },
        relationships: { nestedEntries: [] },
        links: { externalReferences: [] },
      });
      const entry = `---
type: lore
name: シンプルロア
fields: {}
---
シンプルな説明。`;
      const zip = makeZip({
        "lore/simple-NC_NO_FIELDS/metadata.json": meta,
        "lore/simple-NC_NO_FIELDS/entry.md": entry,
      });
      const { codexEntries } = parseNovelcrafterZip(zip);
      expect(codexEntries[0].content).toBe("{}");
    });
  });

  describe("codex entries — malformed metadata.json", () => {
    it("skips an entry whose metadata lacks attributes without aborting the import", () => {
      // 構造は valid JSON だが attributes 欠落 → 以前は TypeError で import 全体が停止していた
      const zip = makeZip({
        "characters/broken-NC_BAD/metadata.json": JSON.stringify({
          id: "NC_BAD",
        }),
        "characters/alice-NC_CHAR_001/metadata.json": CHARACTER_METADATA,
        "characters/alice-NC_CHAR_001/entry.md": CHARACTER_ENTRY,
      });
      const result = parseNovelcrafterZip(zip);
      // 壊れたエントリは skip、正常なエントリは残る
      expect(result.codexEntries).toHaveLength(1);
      expect(result.codexEntries[0].ncId).toBe("NC_CHAR_001");
    });
  });

  describe("novel body — chapters/scenes", () => {
    it("parses ## as chapters and ### as scenes, capturing body verbatim", () => {
      const novel = `# Title
by Author

## Act 1

### 導入

- 主人公が目覚める
- 異変に気付く

---

朝、太郎は目を覚ました。

### 出発

- 旅の準備をする

## Act 2

### 戦闘

- 敵と遭遇

---

剣を抜いた。`;
      const zip = makeZip({ "novel.md": novel });
      const { chapters } = parseNovelcrafterZip(zip);

      expect(chapters).toHaveLength(2);
      expect(chapters[0].title).toBe("Act 1");
      expect(chapters[0].scenes).toHaveLength(2);
      expect(chapters[0].scenes[0].title).toBe("導入");
      // body は bullets / 区切り / 本文 をすべて含む
      expect(chapters[0].scenes[0].body).toBe(
        "- 主人公が目覚める\n- 異変に気付く\n\n---\n\n朝、太郎は目を覚ました。",
      );
      expect(chapters[0].scenes[1].body).toBe("- 旅の準備をする");
      expect(chapters[1].scenes[0].body).toBe(
        "- 敵と遭遇\n\n---\n\n剣を抜いた。",
      );
    });

    it("returns empty array when novel.md is missing", () => {
      const { chapters } = parseNovelcrafterZip(makeZip({}));
      expect(chapters).toEqual([]);
    });

    it("places scenes without an enclosing ## under a synthetic chapter", () => {
      const novel = `# Title

### orphan

- bullet`;
      const { chapters } = parseNovelcrafterZip(makeZip({ "novel.md": novel }));
      expect(chapters).toHaveLength(1);
      expect(chapters[0].scenes[0].title).toBe("orphan");
    });
  });

  describe("chat sessions", () => {
    const chat = `---
title: ""
favourite: false
---
## User
こんにちは

## AI
こんにちは。何かお手伝いしますか？

## User
小説のアドバイスをください。
`;

    it("parses chat file into a session with messages", () => {
      const zip = makeZip({ "chats/2026-03-07 abc123.md": chat });
      const { chatSessions } = parseNovelcrafterZip(zip);

      expect(chatSessions).toHaveLength(1);
      expect(chatSessions[0].messages).toHaveLength(3);
      expect(chatSessions[0].messages[0]).toEqual({
        role: "user",
        content: "こんにちは",
      });
      expect(chatSessions[0].messages[1].role).toBe("assistant");
      expect(chatSessions[0].messages[2].role).toBe("user");
    });

    it("uses date prefix from filename as createdAt", () => {
      const zip = makeZip({ "chats/2026-03-07 abc123.md": chat });
      const { chatSessions } = parseNovelcrafterZip(zip);
      expect(chatSessions[0].createdAt.startsWith("2026-03-07")).toBe(true);
    });

    it("falls back to first user message preview when title is empty", () => {
      const zip = makeZip({ "chats/2026-03-07 abc123.md": chat });
      const { chatSessions } = parseNovelcrafterZip(zip);
      expect(chatSessions[0].title).toBe("こんにちは");
    });

    it("uses frontmatter title when provided", () => {
      const titled = `---
title: "アイデア出し"
favourite: false
---
## User
本文`;
      const zip = makeZip({ "chats/2026-03-07 x.md": titled });
      const { chatSessions } = parseNovelcrafterZip(zip);
      expect(chatSessions[0].title).toBe("アイデア出し");
    });
  });
});
