/**
 * @vitest-environment happy-dom
 *
 * 撮影シードの統合テスト。createBrowserMock() は init 時に
 * seedScreenshotWorkspace を実行するので、言語ごとに「SQL が
 * バインド数不一致などで落ちないこと」と「投入内容が言語に追従すること」を
 * 実 DB（sql.js）で検証する。ユニットテストでは通らない seed 経路の番人。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserMock, type BrowserMock } from "./browser-mock";
import {
  SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY,
  SCREENSHOT_MODE_LOCALSTORAGE_KEY,
} from "@/screenshot-scenes/screenshotMode";
import { SCREENSHOT_SEED_CONTENT } from "@/screenshot-scenes/screenshotSeedContent";

async function scalar(
  mock: BrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params },
  );
  return rows[0];
}

async function count(mock: BrowserMock, table: string): Promise<number> {
  const row = await scalar(mock, `SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

describe("seedScreenshotWorkspace via createBrowserMock", () => {
  beforeEach(() => {
    localStorage.setItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY, "true");
  });
  afterEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
    localStorage.removeItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY);
  });

  for (const lang of ["ja", "en"] as const) {
    describe(`[${lang}]`, () => {
      it("seeds without SQL bind errors and matches the language content", async () => {
        localStorage.setItem(SCREENSHOT_LANGUAGE_LOCALSTORAGE_KEY, lang);
        const c = SCREENSHOT_SEED_CONTENT[lang];

        // init 時にシードが走る。バインド数不一致ならここで throw する。
        const mock = await createBrowserMock();

        const project = await scalar(
          mock,
          "SELECT title, language FROM projects WHERE id = 'default-project'",
        );
        expect(project?.title).toBe(c.project.title);
        expect(project?.language).toBe(lang);

        // 3 シーン + 1 章フォルダ
        expect(await count(mock, "tree_nodes")).toBe(4);
        const scene1 = await scalar(
          mock,
          "SELECT title, char_count, chronicle_start_time, chronicle_start_granularity FROM tree_nodes WHERE id = 'scene-1'",
        );
        expect(scene1?.title).toBe(c.scenes.scene1.title);
        expect(scene1?.char_count).toBe(c.scenes.scene1.charCount);
        expect(scene1?.chronicle_start_time).toBe(150);
        expect(scene1?.chronicle_start_granularity).toBe("day");

        // codex 5 件、name は言語追従
        expect(await count(mock, "codex_entries")).toBe(5);
        const akahimo = await scalar(
          mock,
          "SELECT name FROM codex_entries WHERE id = 'codex-akahimo'",
        );
        expect(akahimo?.name).toBe(c.codex.akahimo.name);

        // snippet / foreshadow / setup / chat / authorship / map edges が
        // 全行 INSERT されている（バインド数不一致だと 0 行や throw になる）
        expect(await count(mock, "snippets")).toBe(2);
        expect(await count(mock, "foreshadows")).toBe(2);
        expect(await count(mock, "foreshadow_setups")).toBe(2);
        expect(await count(mock, "chat_messages")).toBe(2);
        expect(await count(mock, "authorship_spans")).toBe(5);
        expect(await count(mock, "map_edges")).toBe(2);

        // 新しい撮影対象（作中年表・執筆統計）が空状態にならない。
        expect(await count(mock, "events")).toBe(4);
        expect(await count(mock, "event_participants")).toBe(5);
        expect(await count(mock, "scene_events")).toBe(2);
        expect(await count(mock, "event_relations")).toBe(3);
        expect(await count(mock, "change_events")).toBe(14);

        const chronicleReturn = await scalar(
          mock,
          "SELECT title FROM events WHERE id = 'shot-event-return'",
        );
        expect(chronicleReturn?.title).toBe(c.chronicle.returnHome.title);

        const setup = await scalar(
          mock,
          "SELECT from_pos, to_pos, ai_reasoning FROM foreshadow_setups WHERE id = 'setup-akahimo-warmth'",
        );
        expect(setup?.from_pos).toBe(c.foreshadows.setupWarmth.fromPos);
        expect(setup?.to_pos).toBe(c.foreshadows.setupWarmth.toPos);
        expect(setup?.ai_reasoning).toBe(c.foreshadows.setupWarmth.aiReasoning);

        const assistant = await scalar(
          mock,
          "SELECT content FROM chat_messages WHERE id = 'chat-message-assistant-1'",
        );
        expect(assistant?.content).toBe(c.chat.assistantMsg);

        // invoke 経路（注釈・ゴミ箱）も言語追従
        const { annotations } = await mock.invoke<{
          annotations: { textSnapshot: string }[];
        }>("list_annotations_for_project");
        expect(annotations.map((a) => a.textSnapshot)).toEqual([
          c.annotations.compassDry.textSnapshot,
          c.annotations.foreignMemory.textSnapshot,
        ]);

        const trash =
          await mock.invoke<{ previewText: string }[]>("trash_bin_list");
        expect(trash.map((t) => t.previewText)).toEqual([
          c.trash.sceneDraft.previewText,
          c.trash.textFragment.previewText,
        ]);
      });
    });
  }
});
