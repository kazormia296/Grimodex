// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MP-4b PR-7a：年表の read tool 4 本（list_events・get_event_detail・get_character_timeline・
 * get_chronicle_state）の、PR-0 の golden が覆わない legacy の挙動の特性試験。**共有 core へ移す前に
 * 未変更の legacy で通し、移した後も無変更で通る**ことが「結果を 1 byte も変えない」の証拠になる。
 *
 * 固定するもの（DR-MP4-37）：
 * - store の読取り位置：get_event_detail の nodes の 2 回目の読み（場面の題）、get_character_timeline・
 *   get_chronicle_state の場面・nodes の読み。await の最中に store を書き換えて、どの読みが await の前後に
 *   あるかを見る（PR-0 の試験は list_events と search_events だけを固定していた）。
 * - 場面自身の暦日付（scene-own anchor）。
 * - UI 言語の正規化（`"en"` の完全一致だけが en。`"en-US"` は ja）。
 * - Codex の hidden な entry の名前を、4 本ともそのまま返すこと（既存の非対称。直さない）。
 * 実 sql.js の golden と同じ harness を使い、足す行は `__fixtures__/chronicleCharacterizationSeed.ts`。
 */
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  const { legacyReadInvokeBridge } =
    await import("./legacyReadInvokeBridge.testSupport");
  legacyReadInvokeBridge.bindActual(actual.invoke as never);
  return { ...actual, invoke: legacyReadInvokeBridge.invoke };
});
vi.mock("../contextBuilder", () => ({
  countTokens: (s: string) => (s ? s.length : 0),
}));

import { invoke } from "@/lib/tauri";
import i18next, { ensureLocale } from "@/lib/i18n";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { executeTool } from "./toolExecutors";
import {
  CHRONICLE_CHARACTERIZATION_STATEMENTS,
  CHRONICLE_HIDDEN_NAME_EVENT,
  CHRONICLE_SCENE_OWN_ANCHOR_SCENE,
} from "./__fixtures__/chronicleCharacterizationSeed";
import { legacyReadInvokeBridge } from "./legacyReadInvokeBridge.testSupport";
import {
  bindLegacyReadHarnessPorts,
  seedLegacyReadFixture,
  setLegacyReadWorkspaceIdentity,
  setLegacyReadWorld,
  type LegacyReadWorld,
} from "./legacyReadHarness.testSupport";
import { invalidateChronicleToolCache } from "./chronicleToolCache";

bindLegacyReadHarnessPorts({
  executeRun: (sql, params) =>
    invoke("db_execute", { sql, params, method: "run" }),
  setTreeState: (state) => useTreeStore.setState(state),
  setPhaseState: (state) => usePhaseStore.setState(state),
});

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MAIN_S1: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s1" };
const MAIN_S3: LegacyReadWorld = { projectId: "p-main", activeSceneId: "n-s3" };

type Content<T> = { content: T; summary: string };
const run = async <T = unknown>(
  tool: string,
  params: Record<string, unknown>,
): Promise<Content<T>> => {
  const result = await executeTool(tool, "c", params);
  expect(result.error).toBeUndefined();
  return { content: result.content as T, summary: result.summary };
};

/** 最初に `fromTable` を読む `db_execute` が呼ばれた瞬間に、store を書き換える。 */
function onFirstRead(
  fromTable: string,
  mutate: () => void,
): { fired: () => boolean } {
  let done = false;
  legacyReadInvokeBridge.setOnCall(({ cmd, args }) => {
    if (
      !done &&
      cmd === "db_execute" &&
      new RegExp(`from "${fromTable}"`, "iu").test(String(args?.sql))
    ) {
      done = true;
      mutate();
    }
  });
  return { fired: () => done };
}

/** 最初の `db_execute` の前（呼出しの冒頭）に store を書き換える。 */
function onFirstCall(mutate: () => void): { fired: () => boolean } {
  let done = false;
  legacyReadInvokeBridge.setOnCall(() => {
    if (!done) {
      done = true;
      mutate();
    }
  });
  return { fired: () => done };
}

describe("年表 4 本の legacy の特性（移す前に通し、移した後も無変更で通す）", () => {
  beforeAll(async () => {
    await seedLegacyReadFixture();
    for (const { sql, params } of CHRONICLE_CHARACTERIZATION_STATEMENTS) {
      await invoke("db_execute", { sql, params: [...params], method: "run" });
    }
  });

  beforeEach(() => {
    setLegacyReadWorkspaceIdentity();
    legacyReadInvokeBridge.reset();
  });

  describe("store の読取り位置", () => {
    it("get_event_detail：現在の場面は events の読みの後で読む（events の最中に n-s3 へ切り替えると戦争が見える）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      const hook = onFirstRead("events", () =>
        useTreeStore.setState({ activeSceneId: "n-s3" }),
      );
      const found = await run<{ id: string } | null>("get_event_detail", {
        eventId: "ev-war",
      });
      expect(hook.fired()).toBe(true);
      expect(found.content?.id).toBe("ev-war");
    });

    it("get_event_detail：現在の場面は scene_events の読みの前に読み終える（その最中の切替は反映されない）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      const hook = onFirstRead("scene_events", () =>
        useTreeStore.setState({ activeSceneId: "n-s3" }),
      );
      const found = await run("get_event_detail", { eventId: "ev-war" });
      expect(hook.fired()).toBe(true);
      expect(found.content).toBeNull();
      expect(found.summary).toBe("Event not found");
    });

    it("get_event_detail：場面の題は await（Promise.all）の後の store の nodes から作る（最中に題を書き換えると反映される）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const hook = onFirstRead("project_calendar", () =>
        useTreeStore.setState({
          nodes: useTreeStore
            .getState()
            .nodes.map((n) =>
              n.id === "n-s1" ? { ...n, title: "差し替え" } : n,
            ),
        }),
      );
      const found = await run<{
        scenes: Array<{ sceneId: string; title: string | null }>;
      }>("get_event_detail", { eventId: "ev-meet" });
      expect(hook.fired()).toBe(true);
      expect(found.content.scenes).toEqual([
        { sceneId: "n-s1", title: "差し替え" },
      ]);
    });

    it("get_character_timeline：現在の場面は events・participants・calendar・名前の await の後で読む（最中に n-s3 へ切り替えると戦争が見える）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      const baseline = await run<{ events: Array<{ id: string }> }>(
        "get_character_timeline",
        { codexId: "c-mage" },
      );
      expect(baseline.content.events.map((e) => e.id)).not.toContain("ev-war");

      await setLegacyReadWorld(MAIN_S1);
      const hook = onFirstRead("project_calendar", () =>
        useTreeStore.setState({ activeSceneId: "n-s3" }),
      );
      const switched = await run<{ events: Array<{ id: string }> }>(
        "get_character_timeline",
        { codexId: "c-mage" },
      );
      expect(hook.fired()).toBe(true);
      expect(switched.content.events.map((e) => e.id)).toContain("ev-war");
    });

    it("get_character_timeline：現在の場面は scene_events の読みの前に読み終える（その最中の切替は反映されない）", async () => {
      await setLegacyReadWorld(MAIN_S1);
      const hook = onFirstRead("scene_events", () =>
        useTreeStore.setState({ activeSceneId: "n-s3" }),
      );
      const found = await run<{ events: Array<{ id: string }> }>(
        "get_character_timeline",
        { codexId: "c-mage" },
      );
      expect(hook.fired()).toBe(true);
      expect(found.content.events.map((e) => e.id)).not.toContain("ev-war");
    });

    it("get_chronicle_state：sceneId は最初の await の前に決める（activeSceneId を最初の読みの最中に変えても結果は変わらない）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const baseline = await run("get_chronicle_state", {});
      await setLegacyReadWorld(MAIN_S3);
      const hook = onFirstCall(() =>
        useTreeStore.setState({ activeSceneId: "n-s1" }),
      );
      const switched = await run("get_chronicle_state", {});
      expect(hook.fired()).toBe(true);
      expect(JSON.stringify(switched)).toBe(JSON.stringify(baseline));
    });

    it("get_chronicle_state：sceneId を渡せば activeSceneId は読まない（渡した場面が secret の位置にもなる）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const hook = onFirstCall(() =>
        useTreeStore.setState({ activeSceneId: "n-s1" }),
      );
      const explicit = await run("get_chronicle_state", { sceneId: "n-s3" });
      expect(hook.fired()).toBe(true);
      await setLegacyReadWorld(MAIN_S3);
      const baseline = await run("get_chronicle_state", {});
      expect(JSON.stringify(explicit)).toBe(JSON.stringify(baseline));
    });

    it("get_chronicle_state：nodes（と読む順）は Promise.all の後で読む（最中に nodes を空にすると anchor は none で secret は隠れる）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const baseline = await run("get_chronicle_state", {});
      expect(baseline.summary).toBe("Chronicle state at scene (stamped)");

      await setLegacyReadWorld(MAIN_S3);
      const hook = onFirstRead("project_calendar", () =>
        useTreeStore.setState({ nodes: [] }),
      );
      const emptied = await run("get_chronicle_state", {});
      expect(hook.fired()).toBe(true);
      expect(emptied.summary).toBe("Chronicle state at scene (none)");
      expect(JSON.stringify(emptied.content)).not.toContain("魔術戦争");
    });
  });

  describe("場面自身の暦日付（scene-own anchor）", () => {
    it("日付を持つ場面は、紐づく出来事が無くても source=scene の anchor になる（n-s2）", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const nodeInStore = useTreeStore
        .getState()
        .nodes.find((n) => n.id === CHRONICLE_SCENE_OWN_ANCHOR_SCENE);
      expect(nodeInStore).toMatchObject({
        chronicleStartTime: 7000,
        chronicleStartGranularity: "day",
        chroniclePrecision: "approx",
      });
      const state = await run<Record<string, unknown>>("get_chronicle_state", {
        sceneId: CHRONICLE_SCENE_OWN_ANCHOR_SCENE,
      });
      expect(state.summary).toBe("Chronicle state at scene (scene)");
      // scene-own の暦日付（startTime 7000・approx）が anchor の time になる。
      expect(JSON.stringify(state.content)).toBe(
        '{"time":{"source":"scene","startTime":7000,"season":null,"precision":"approx","formattedDate":"1019年第161日"},"characters":[{"codexId":"c-secret","name":"黒幕","status":"unknown","age":null,"location":"黒幕"},{"codexId":"c-aria","name":"アリア","status":"alive","age":19,"location":"古い塔"},{"codexId":"c-mage","name":"老魔術師","status":"unknown","age":null,"location":"古い塔"}],"recentEvents":[{"eventId":"ev-hidden-name","title":"黒幕の登場","note":null,"relTime":"約3年前"},{"eventId":"ev-meet","title":"老魔術師との出会い","note":null,"relTime":"約4年前"}],"unresolvedCausal":[],"offpage":[]}',
      );
    });

    it("日付を持たない場面は今までどおり stamped（n-s3）、紐づきも日付も無い場面は直前の anchor を proxy で借りる", async () => {
      await setLegacyReadWorld(MAIN_S3);
      expect(
        (await run("get_chronicle_state", { sceneId: "n-s3" })).summary,
      ).toBe("Chronicle state at scene (stamped)");
      expect(
        (await run("get_chronicle_state", { sceneId: "n-s4" })).summary,
      ).toBe("Chronicle state at scene (proxy)");
    });
  });

  describe("UI 言語の正規化", () => {
    const birthDate = async (language: string): Promise<string | null> => {
      await setLegacyReadWorld(MAIN_S3);
      await ensureLocale("en");
      await i18next.changeLanguage(language);
      invalidateChronicleToolCache();
      const list = await run<{
        events: Array<{ id: string; startDate: string | null }>;
      }>("list_events", {});
      return list.content.events.find((e) => e.id === "ev-birth")!.startDate;
    };

    it('"en" の完全一致だけが en（"en-US"・"en-GB"・未知の値・空は ja）', async () => {
      const ja = await birthDate("ja");
      const en = await birthDate("en");
      expect(ja).not.toBeNull();
      expect(en).not.toBeNull();
      expect(en).not.toBe(ja);
      expect(await birthDate("en-US")).toBe(ja);
      expect(await birthDate("en-GB")).toBe(ja);
      expect(await birthDate("fr")).toBe(ja);
      expect(await birthDate("")).toBe(ja);
    });

    it("4 本とも同じ規則（get_event_detail・get_chronicle_state の日付）", async () => {
      const detailDate = async (language: string) => {
        await setLegacyReadWorld(MAIN_S3);
        await ensureLocale("en");
        await i18next.changeLanguage(language);
        invalidateChronicleToolCache();
        return (
          await run<{ startDate: string | null }>("get_event_detail", {
            eventId: "ev-birth",
          })
        ).content.startDate;
      };
      const stateJson = async (language: string) => {
        await setLegacyReadWorld(MAIN_S3);
        await ensureLocale("en");
        await i18next.changeLanguage(language);
        invalidateChronicleToolCache();
        return JSON.stringify((await run("get_chronicle_state", {})).content);
      };
      expect(await detailDate("en-US")).toBe(await detailDate("ja"));
      expect(await detailDate("en")).not.toBe(await detailDate("ja"));
      expect(await stateJson("en-US")).toBe(await stateJson("ja"));
      expect(await stateJson("en")).not.toBe(await stateJson("ja"));
    });
  });

  describe("Codex の hidden な entry の名前（既存の非対称。直さない。DR-MP4-37）", () => {
    it("c-secret は context_mode=hidden だが、4 本とも名前（黒幕）をそのまま返す", async () => {
      await setLegacyReadWorld(MAIN_S3);
      const list = await run<{
        events: Array<{ id: string; primaryCharacter: string | null }>;
      }>("list_events", {});
      expect(
        list.content.events.find((e) => e.id === CHRONICLE_HIDDEN_NAME_EVENT)
          ?.primaryCharacter,
      ).toBe("黒幕");

      const detail = await run<{
        primaryCharacter: string | null;
        location: string | null;
        participants: Array<{ codexId: string; name: string | null }>;
      }>("get_event_detail", { eventId: CHRONICLE_HIDDEN_NAME_EVENT });
      expect(detail.content.primaryCharacter).toBe("黒幕");
      expect(detail.content.location).toBe("黒幕");
      expect(detail.content.participants).toEqual([
        { codexId: "c-secret", name: "黒幕", role: "黒幕役" },
      ]);

      const timeline = await run<{
        character: string;
        events: Array<{ id: string }>;
      }>("get_character_timeline", { codexId: "c-secret" });
      expect(timeline.content.character).toBe("黒幕");
      expect(timeline.content.events.map((e) => e.id)).toContain(
        CHRONICLE_HIDDEN_NAME_EVENT,
      );

      const state = await run("get_chronicle_state", { sceneId: "n-s1" });
      expect(JSON.stringify(state.content)).toContain("黒幕");
    });
  });
});
