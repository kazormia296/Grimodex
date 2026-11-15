// @vitest-environment happy-dom
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "@/lib/i18n";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";

const platform = vi.hoisted(() => ({ mac: false }));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
}));

import { getCommands } from "@/features/settings/keybindings";
import { DEFAULT_SETTINGS } from "@/features/settings/types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useLicenseStore } from "@/features/license/store";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { buildDefaultLayoutState } from "@/features/layout/layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "@/features/layout/toolWindowDefaults";
import { getHelpTopics, parseHelpDoc } from "./helpDocs";
import { collectRefs } from "./helpRefs";
import {
  HELP_KINDS,
  findBrokenRefs,
  getHelpDetail,
  listHelpIndex,
  suggestHelpIds,
} from "./helpIndex";

type LocaleTree = { help?: { commands?: Record<string, string> } };

function defaultSettingsCache(): Record<string, string> {
  return { ...DEFAULT_SETTINGS };
}

beforeEach(() => {
  platform.mac = false;
  useSettingsStore.setState({ cache: defaultSettingsCache() });
  useLicenseStore.setState({ licensingEnabled: false });
});

afterEach(async () => {
  await i18next.changeLanguage("ja");
});

describe("ずれの検出: コマンドの説明", () => {
  it("getCommands() の全件に ja／en の説明がある（欠けを落とす）", () => {
    for (const [name, tree] of [
      ["ja", ja as LocaleTree],
      ["en", en as LocaleTree],
    ] as const) {
      const described = tree.help?.commands ?? {};
      const missing = getCommands()
        .map((command) => command.id)
        .filter((id) => !described[id]?.trim());
      expect(missing, `${name} の help.commands に説明が無いコマンド`).toEqual(
        [],
      );
    }
  });

  it("registry に無いコマンドの説明が残っていない", () => {
    const ids = new Set(getCommands().map((command) => command.id));
    for (const tree of [ja as LocaleTree, en as LocaleTree]) {
      const stale = Object.keys(tree.help?.commands ?? {}).filter(
        (id) => !ids.has(id),
      );
      expect(stale).toEqual([]);
    }
  });
});

describe("ずれの検出: ヘルプ文書", () => {
  it("文書は 5〜8 項目で、id が重複しない", () => {
    const topics = getHelpTopics();
    expect(topics.length).toBeGreaterThanOrEqual(5);
    expect(topics.length).toBeLessThanOrEqual(8);
    expect(new Set(topics.map((topic) => topic.id)).size).toBe(topics.length);
  });

  it("topics/ の md がすべて登録されている（登録漏れを落とす）", () => {
    const onDisk = readdirSync(path.resolve(process.cwd(), "src/help/topics"))
      .filter((name) => name.endsWith(".md"))
      .sort();
    expect(getHelpTopics()).toHaveLength(onDisk.length);
  });

  it("全文書の参照（command／panel／settings／preset／t）が実在する", () => {
    for (const topic of getHelpTopics()) {
      expect(findBrokenRefs(topic.body), topic.id).toEqual([]);
    }
  });

  it("実在しない ID への参照を落とす", () => {
    expect(findBrokenRefs("{{command:noSuchCommand}}")).toEqual([
      "{{command:noSuchCommand}}",
    ]);
    expect(findBrokenRefs("{{panel:nope}}")).toHaveLength(1);
    expect(findBrokenRefs("{{settings:nope}}")).toHaveLength(1);
    expect(findBrokenRefs("{{preset:builtin:nope}}")).toHaveLength(1);
    expect(findBrokenRefs("{{t:no.such.key}}")).toHaveLength(1);
    expect(findBrokenRefs("{{command: focusChat}}")).toHaveLength(1);
    expect(findBrokenRefs("{{command:focusChat}}")).toEqual([]);
  });

  it("本文にキーの組み合わせや UI の名前を直書きしていない（参照で書く）", () => {
    const keyCombo = /\b(?:Ctrl|Cmd|Alt|Option|Shift)\s*\+/;
    for (const topic of getHelpTopics()) {
      const prose = topic.body.replace(/\{\{[^}]*\}\}/g, "");
      expect(prose, topic.id).not.toMatch(keyCombo);
      expect(prose, topic.id).not.toMatch(/[⌘⌥⇧⌃]+[A-Z0-9]/);
    }
  });

  it("frontmatter が不正な文書を拒否する", () => {
    expect(() => parseHelpDoc("本文だけ", "x.md")).toThrow(/frontmatter/);
    expect(() =>
      parseHelpDoc("---\nid: a b\ntitle: t\n---\nx", "x.md"),
    ).toThrow(/id が不正/);
    expect(() => parseHelpDoc("---\nid: a\n---\nx", "x.md")).toThrow(/title/);
    expect(() => parseHelpDoc("---\nid: a\ntitle: t\n---\n", "x.md")).toThrow(
      /本文/,
    );
  });
});

describe("索引", () => {
  it("コマンド・パネル・設定カテゴリ・文書を全件含み、id が重複しない", () => {
    const { total, items } = listHelpIndex();
    expect(total).toBe(items.length);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const ids = new Set(items.map((item) => item.id));
    for (const command of getCommands()) {
      expect(ids.has(`command:${command.id}`)).toBe(true);
    }
    for (const panel of ["editor", ...TOOL_WINDOW_PANEL_IDS]) {
      expect(ids.has(`panel:${panel}`)).toBe(true);
    }
    for (const topic of getHelpTopics()) {
      expect(ids.has(`topic:${topic.id}`)).toBe(true);
    }
    for (const item of items) {
      expect(HELP_KINDS).toContain(item.kind);
      expect(item.title.length).toBeGreaterThan(0);
      expect(Object.keys(item).sort()).toEqual(["id", "kind", "title"]);
    }
  });

  it("License カテゴリは licensing が有効なときだけ載る（CategoryNav と同じ）", () => {
    expect(listHelpIndex().items.map((item) => item.id)).not.toContain(
      "settings:license",
    );
    useLicenseStore.setState({ licensingEnabled: true });
    expect(listHelpIndex().items.map((item) => item.id)).toContain(
      "settings:license",
    );
    expect(getHelpDetail("settings:license")).not.toBeNull();
  });

  it("kind で絞り込める", () => {
    const { items } = listHelpIndex({ kind: "settingsCategory" });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.kind === "settingsCategory")).toBe(true);
  });

  it("query で絞り込める（語・自然文・英語の id）", () => {
    const split = listHelpIndex({ query: "分割" }).items.map((i) => i.id);
    expect(split).toContain("topic:editor.tabsAndSplit");
    expect(split).toContain("command:splitVertical");
    expect(split).not.toContain("command:focusChat");

    const sentence = listHelpIndex({ query: "エディタを分割するには？" }).items;
    expect(sentence[0]?.id).toBe("topic:editor.tabsAndSplit");

    expect(
      listHelpIndex({ query: "focusChat" }).items.map((i) => i.id),
    ).toContain("command:focusChat");
  });

  it("載っていない機能は 0 件になる（無いと答えるため）", () => {
    expect(listHelpIndex({ query: "ブロックチェーン" }).total).toBe(0);
  });

  it("存在しない ID に近い項目を案内する", () => {
    expect(suggestHelpIds("command:focusChatt").map((i) => i.id)).toContain(
      "command:focusChat",
    );
  });
});

describe("詳細: コマンド", () => {
  it("実際のキー割当（ユーザーの上書き反映）と既定、今の OS での可否を返す", () => {
    const base = getHelpDetail("command:focusChat")!;
    expect(base["keys"]).toBe("Ctrl+Alt+C");
    expect(base["customized"]).toBe(false);
    expect(base["availableOnThisOS"]).toBe(true);
    expect(base["os"]).toBe("Windows/Linux");
    expect(base["description"]).toEqual(expect.any(String));
    expect(base["panel"]).toEqual({ id: "panel:chat", title: "チャット" });

    useSettingsStore.setState({
      cache: {
        ...defaultSettingsCache(),
        "keys.bindings": JSON.stringify({ focusChat: "Mod+Alt+Y" }),
      },
    });
    const custom = getHelpDetail("command:focusChat")!;
    expect(custom["keys"]).toBe("Ctrl+Alt+Y");
    expect(custom["defaultKeys"]).toBe("Ctrl+Alt+C");
    expect(custom["customized"]).toBe(true);
  });

  it("macOS ではキーを記号で返し、使えないコマンドを使えないと返す", () => {
    platform.mac = true;
    expect(getHelpDetail("command:focusChat")!["keys"]).toBe("⌥⌘C");
    expect(getHelpDetail("command:nextTab")!["keys"]).toBe("⌃Tab");
    const replace = getHelpDetail("command:findReplace")!;
    expect(replace["availableOnThisOS"]).toBe(false);
    expect(replace["os"]).toBe("macOS");
    expect(replace["note"]).toEqual(expect.any(String));

    platform.mac = false;
    expect(getHelpDetail("command:findReplace")!["availableOnThisOS"]).toBe(
      true,
    );
  });

  it("割当を外したコマンドは keys が null", () => {
    useSettingsStore.setState({
      cache: {
        ...defaultSettingsCache(),
        "keys.bindings": JSON.stringify({ find: "" }),
      },
    });
    expect(getHelpDetail("command:find")!["keys"]).toBeNull();
  });
});

describe("詳細: パネル・設定カテゴリ・文書", () => {
  it("パネルは表示状態と、そのパネルを開閉するコマンドのキーを返す", () => {
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
    });
    expect(getHelpDetail("panel:chat")).toMatchObject({
      kind: "panel",
      open: false,
      shortcut: { id: "command:focusChat", keys: "Ctrl+Alt+C" },
    });
    useLayoutStore.getState().showPanel("chat");
    expect(getHelpDetail("panel:chat")!["open"]).toBe(true);
    expect(getHelpDetail("panel:editor")!["shortcut"]).toBeNull();
  });

  it("設定カテゴリは名前と「設定を開く」案内を返す", () => {
    const detail = getHelpDetail("settings:keys")!;
    expect(detail["title"]).toBe("Keys");
    expect(detail["howToOpen"]).toContain("Keys");
    expect(detail["howToOpen"]).toContain("Ctrl+Alt+,");
  });

  it("文書は参照を展開し、実際のキー割当と UI 言語のラベルを入れる", async () => {
    const body = getHelpDetail("topic:editor.tabsAndSplit")!["body"] as string;
    expect(body).not.toContain("{{");
    expect(body).toContain("「次のタブに移動」（Ctrl+Tab）");

    useSettingsStore.setState({
      cache: {
        ...defaultSettingsCache(),
        "keys.bindings": JSON.stringify({ nextTab: "Mod+Alt+J" }),
      },
    });
    expect(
      getHelpDetail("topic:editor.tabsAndSplit")!["body"] as string,
    ).toContain("「次のタブに移動」（Ctrl+Alt+J）");

    platform.mac = true;
    const findReplace = getHelpDetail("topic:editor.findAndReplace")![
      "body"
    ] as string;
    expect(findReplace).toContain("macOS では使えない");

    platform.mac = false;
    await i18next.changeLanguage("en");
    const english = getHelpDetail("topic:layout.presets")!["body"] as string;
    expect(english).toContain(`「${i18next.t("layout.preset.title")}」`);
    expect(english).toContain(`「${i18next.t("layout.preset.plan")}」`);
    expect(english).not.toContain("{{");
  });

  it("文書は関連するコマンド・パネル・設定カテゴリの id を返し、全件が実在する", () => {
    for (const topic of getHelpTopics()) {
      const detail = getHelpDetail(`topic:${topic.id}`)!;
      const related = detail["related"] as string[];
      for (const id of related) {
        expect(getHelpDetail(id), `${topic.id} → ${id}`).not.toBeNull();
      }
      expect(collectRefs(topic.body).length, topic.id).toBeGreaterThan(0);
    }
  });

  it("存在しない id は null（作られた id は実行しない）", () => {
    for (const id of [
      "",
      "focusChat",
      "command:nope",
      "panel:nope",
      "settings:nope",
      "topic:nope",
      "unknown:focusChat",
      "command:",
    ]) {
      expect(getHelpDetail(id), id).toBeNull();
    }
  });
});

describe("設定の値を返さない", () => {
  it("全項目の索引・詳細に、設定の値（API key・endpoint 等）が出ない", () => {
    const sentinel = "SENTINEL-DO-NOT-LEAK-7f3a";
    const poisoned: Record<string, string> = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      poisoned[key] = sentinel;
    }
    // 実在しないキーも含め、秘密になり得る名前を入れる。
    for (const key of ["ai.apiKey", "ai.endpoint", "ai.openaiCompatible.key"]) {
      poisoned[key] = sentinel;
    }
    // 割当の上書きだけは、キー割当として正当に読まれる。
    poisoned["keys.bindings"] = "{}";
    useSettingsStore.setState({ cache: poisoned });
    useLicenseStore.setState({ licensingEnabled: true });

    const { items } = listHelpIndex();
    const dump = JSON.stringify([
      items,
      ...items.map((item) => getHelpDetail(item.id)),
    ]);
    expect(dump).not.toContain(sentinel);
    expect(items.length).toBeGreaterThan(40);
  });
});
