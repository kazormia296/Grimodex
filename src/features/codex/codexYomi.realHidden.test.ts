import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { codexEntries, codexEntryPhases, projects } from "@/db/schema";
import { createBrowserMock } from "@/lib/browser-mock";
import { installBrowserMock } from "@/lib/tauri";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { useTreeStore } from "@/features/tree/treeStore";

// 読みの推定（inferReadings）を、hidden の判定の実物（listCodexIdsHiddenFromAi）と実物の DB 層
// （in-memory の sql.js）で通す。mock するのは AI へ出る境界（sendChatMessageWithThinking）と、
// 試験環境で無関係な gate・使用量の記録だけ。
//
// 判定の helper を mock した試験（codexYomi.codexHidden.test.ts）では、projectId が空・
// helper が id を見つけられないときに、全件が送られない／失敗になる回帰を検出できない。
// ここでは、その今の振る舞いを固定する。

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: h.send,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));

import { inferReadings, CODEX_YOMI_HIDDEN_CHECK_FAILED } from "./codexYomi";
import { listCodexIdsHiddenFromAi } from "./context/codexHiddenFromAi";

const P1 = "yomi-real-project-1";
const P2 = "yomi-real-project-2";

// id・表記は、prompt の定型文や互いの部分文字列にならない固有の文字列にする。
const ENTRIES = {
  mentioned: { id: "id-mentioned-7f3a", surface: "刹那の剣聖" },
  always: { id: "id-always-91bc", surface: "常在の宰相" },
  suppress: { id: "id-suppress-c40d", surface: "抑制の司祭" },
  hidden: { id: "id-hidden-2e8f", surface: "秘匿の帝都" },
} as const;

type Mode = keyof typeof ENTRIES;

async function putEntry(
  mode: Mode,
  contextMode: string,
  projectId = P1,
): Promise<void> {
  await db.insert(codexEntries).values({
    id: ENTRIES[mode].id,
    projectId,
    type: "character",
    name: ENTRIES[mode].surface,
    content: "{}",
    contextMode,
  });
}

const yomiEntry = (mode: Mode) => ({
  id: ENTRIES[mode].id,
  category: "人物",
  surfaces: [ENTRIES[mode].surface],
});

function sentPrompt(): string {
  const messages = h.send.mock.calls[0]?.[0] as Array<{ content: string }>;
  return messages[0].content;
}

beforeEach(async () => {
  publishCurrentProjectId(P1);
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
  const now = new Date().toISOString();
  await db.delete(codexEntryPhases);
  await db.delete(codexEntries);
  await db.delete(projects);
  await db.insert(projects).values([
    { id: P1, title: "One", language: "ja", createdAt: now, updatedAt: now },
    { id: P2, title: "Two", language: "ja", createdAt: now, updatedAt: now },
  ]);
  useTreeStore.setState({ projectId: P1 });
  h.send.mockReset();
  h.send.mockResolvedValue({
    text: JSON.stringify({
      readings: [
        {
          id: ENTRIES.mentioned.id,
          surface: "刹那の剣聖",
          yomi: "せつなのけんせい",
        },
      ],
    }),
    inputTokens: 1,
    outputTokens: 1,
  });
});

describe("inferReadings × 実物の hidden 判定 × 実物の DB 層", () => {
  it("projectId を設定した状態で、mentioned・always・suppress の id と表記は送られ、hidden のものは渡らない", async () => {
    await putEntry("mentioned", "mentioned");
    await putEntry("always", "always");
    await putEntry("suppress", "suppress");
    await putEntry("hidden", "hidden");
    expect(useTreeStore.getState().projectId).toBe(P1);

    const result = await inferReadings([
      yomiEntry("mentioned"),
      yomiEntry("always"),
      yomiEntry("suppress"),
      yomiEntry("hidden"),
    ]);

    // 空振りの緑を避けるため、送信が実際に 1 回あることを先に確かめる。
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][1]).toMatchObject({
      projectId: P1,
      pathId: "codex_yomi",
    });
    const prompt = sentPrompt();
    for (const mode of ["mentioned", "always", "suppress"] as const) {
      expect(prompt).toContain(ENTRIES[mode].id);
      expect(prompt).toContain(ENTRIES[mode].surface);
    }
    expect(prompt).not.toContain(ENTRIES.hidden.id);
    expect(prompt).not.toContain(ENTRIES.hidden.surface);
    expect(result.get(ENTRIES.mentioned.id)).toEqual([
      { surface: "刹那の剣聖", yomi: "せつなのけんせい" },
    ]);
  });

  it("DB に無い id は hidden 扱いで送られない（実物の判定。不明な mode は DB の CHECK 制約で保存できない）", async () => {
    await putEntry("mentioned", "mentioned");

    await inferReadings([
      yomiEntry("mentioned"),
      yomiEntry("hidden"), // DB に行が無い
    ]);

    expect(h.send).toHaveBeenCalledTimes(1);
    const prompt = sentPrompt();
    expect(prompt).toContain(ENTRIES.mentioned.surface);
    expect(prompt).not.toContain(ENTRIES.hidden.surface);
  });

  it("projectId が null・空文字だと、送信前の audit の guard で reject し何も送らない（fail-closed。hidden 判定の失敗ではない）", async () => {
    await putEntry("mentioned", "mentioned");
    await putEntry("hidden", "hidden");

    for (const empty of [null, ""]) {
      h.send.mockClear();
      useTreeStore.setState({ projectId: empty as unknown as string });
      const error = await inferReadings([
        yomiEntry("mentioned"),
        yomiEntry("hidden"),
      ]).then(
        () => null,
        (e: unknown) => e as Error & { code?: string },
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain("AI audit requires a project");
      expect(error?.code).not.toBe(CODEX_YOMI_HIDDEN_CHECK_FAILED);
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  it("projectId が空白だけだと、helper が project で絞って全件を「DB に無い」と判定し、送信 0 回・空の結果になる（fail-closed。reject はしない）", async () => {
    await putEntry("mentioned", "mentioned");
    useTreeStore.setState({ projectId: "  " });

    const result = await inferReadings([yomiEntry("mentioned")]);

    expect(result.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("別 project の id（projectId が合わず DB で見つからない）は全件 hidden 扱いで、送信 0 回・空の結果になる（fail-closed）", async () => {
    // 項目は P1 にあるが、store の projectId は P2。
    await putEntry("mentioned", "mentioned");
    await putEntry("always", "always");
    useTreeStore.setState({ projectId: P2 });

    const result = await inferReadings([
      yomiEntry("mentioned"),
      yomiEntry("always"),
    ]);

    expect(result.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("base が mentioned で Phase の override が hidden でも、inferReadings は送る（sceneId を渡さず anchor が base のため Phase を見ない）", async () => {
    await putEntry("mentioned", "mentioned");
    const now = new Date().toISOString();
    await db.insert(codexEntryPhases).values({
      id: "phase-hide-1",
      entryId: ENTRIES.mentioned.id,
      anchorNodeId: null,
      label: "hide",
      contextModeOverride: "hidden",
      createdAt: now,
      updatedAt: now,
    });
    const { listPhasesByEntryIds } = await import("./phaseApi");
    // 実物の phase の層が、この Phase の行を返している（空振りでないことの確認）。
    expect(
      (await listPhasesByEntryIds([ENTRIES.mentioned.id])).map((p) => p.id),
    ).toEqual(["phase-hide-1"]);

    await inferReadings([yomiEntry("mentioned")]);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toContain(ENTRIES.mentioned.surface);
  });
});

describe("listCodexIdsHiddenFromAi（実物）の判定の基準", () => {
  it("projectId が null だと project で絞らず id だけで判定する（別 project の hidden も hidden、他 project の mentioned は hidden でない）", async () => {
    await putEntry("mentioned", "mentioned", P2);
    await putEntry("hidden", "hidden", P2);
    const ids = [ENTRIES.mentioned.id, ENTRIES.hidden.id];

    expect([
      ...(await listCodexIdsHiddenFromAi({ entryIds: ids, projectId: null })),
    ]).toEqual([ENTRIES.hidden.id]);
    // projectId が合っていれば同じ結果、合わなければ全件 hidden。
    expect([
      ...(await listCodexIdsHiddenFromAi({ entryIds: ids, projectId: P2 })),
    ]).toEqual([ENTRIES.hidden.id]);
    expect(
      [
        ...(await listCodexIdsHiddenFromAi({ entryIds: ids, projectId: P1 })),
      ].sort(),
    ).toEqual([...ids].sort());
  });

  it("sceneId を渡さない（anchor が base）と Phase の override を見ず、base の mode で判定する（hidden の Phase でも mentioned は通り、解除の Phase でも hidden は hidden のまま）", async () => {
    await putEntry("mentioned", "mentioned");
    await putEntry("hidden", "hidden");
    const now = new Date().toISOString();
    await db.insert(codexEntryPhases).values([
      {
        id: "phase-hide-2",
        entryId: ENTRIES.mentioned.id,
        label: "hide",
        contextModeOverride: "hidden",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "phase-release-2",
        entryId: ENTRIES.hidden.id,
        label: "release",
        contextModeOverride: "mentioned",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const ids = [ENTRIES.mentioned.id, ENTRIES.hidden.id];

    const hidden = await listCodexIdsHiddenFromAi({
      entryIds: ids,
      projectId: P1,
    });

    expect([...hidden]).toEqual([ENTRIES.hidden.id]);
  });
});
