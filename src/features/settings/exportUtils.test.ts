// @vitest-environment happy-dom
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * exportAsMarkdown：folder の見出し・tree の読む順（DFS）・archived の除外。
 *
 * 実 sql.js（browser-mock）に legacy read の seed（main project）を入れて呼ぶ。
 * archived は外部 Markdown のマウントでファイルの消失・重複により自動で soft delete された行。
 */
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p-main",
}));

import { invoke } from "@/lib/tauri";
import { LEGACY_READ_SEED } from "@/features/chat/agent/__fixtures__/legacyReadSeed";
import { exportAsMarkdown, exportAsPlainText } from "./exportUtils";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

beforeAll(async () => {
  for (const { table, rows } of LEGACY_READ_SEED) {
    for (const row of rows) {
      const columns = Object.keys(row);
      await invoke("db_execute", {
        sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns
          .map(() => "?")
          .join(", ")})`,
        params: columns.map((c) => row[c]),
        method: "run",
      });
    }
  }
});

describe("exportAsMarkdown", () => {
  it("folder を入れ子の深さの見出しにし、tree の読む順（DFS・兄弟ごとの sortOrder）で出す", async () => {
    const md = await exportAsMarkdown();
    const headings = md.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "# 第一部",
      "## 第一章",
      "### 出会い",
      "### 旅立ち",
      "## 第二章",
      "### 裏切り",
      "### 終幕",
      "# 設定メモ",
      // 祖先の folder だけが archived の場面は、listNodes と同じく残り root から届かない行として末尾に出る
      "# 親が消えた場面",
    ]);
    expect(md).toContain("雨の降る朝、アリアは古い塔の前に立っていた。");
    expect(md).toContain("メモの本文。");
  });

  it("archived の場面・folder は出さない（自動 soft delete された外部ファイル・フォルダ）", async () => {
    const md = await exportAsMarkdown();
    expect(md).not.toContain("外部ファイルが消えた場面");
    expect(md).not.toContain("外部ファイルの消失を知らない");
    expect(md).not.toContain("外部フォルダが消えた部");
  });

  it("他 project の行は出さない", async () => {
    const md = await exportAsMarkdown();
    expect(md).not.toContain("他の章");
    expect(md).not.toContain("他作品");
  });

  it("プレーンテキストでも archived を含まず、見出しの # は剥がれる", async () => {
    const text = await exportAsPlainText();
    expect(text).not.toContain("外部ファイルが消えた場面");
    expect(text).not.toMatch(/^#/m);
    expect(text.indexOf("第一章")).toBeLessThan(text.indexOf("第二章"));
  });
});
