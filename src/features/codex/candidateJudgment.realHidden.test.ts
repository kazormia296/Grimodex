import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db/client";
import { codexEntries, codexEntryPhases, projects } from "@/db/schema";
import { createBrowserMock } from "@/lib/browser-mock";
import { installBrowserMock } from "@/lib/tauri";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { useTreeStore } from "@/features/tree/treeStore";
import * as phaseApi from "./phaseApi";

// 候補画面の「AI で評価」（judgeCandidates）を、hidden の判定の実物と実物の DB 層
// （in-memory の sql.js）で通す。mock するのは AI へ出る境界（sendChatMessageWithThinking）と、
// 試験環境で無関係な gate・使用量の記録・project の言語だけ。
//
// 候補画面は場面を持たないので、base が hidden の項目に加えて、Phase でだけ hidden の項目
// （base は公開）も送らないことを固定する（listCodexIdsHiddenFromAi を sceneId なしで呼ぶと
// base だけの判定になり、後者が漏れる）。

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

import { judgeCandidates } from "./candidateJudgment";
import type { CodexCandidate } from "./candidateExtractor";

const P1 = "judge-real-project-1";

// id・名前・別名は、prompt の定型文や互いの部分文字列にならない固有の文字列にする。
const E = {
  baseHidden: {
    id: "id-base-hidden-5a1c",
    name: "秘匿の帝都",
    alias: "影の都ヴォルグ",
    mode: "hidden",
  },
  phaseHidden: {
    id: "id-phase-hidden-9d2e",
    name: "沈黙の司祭",
    alias: "後半で隠す者ゼノ",
    mode: "mentioned",
  },
  phaseReleased: {
    id: "id-phase-released-3b7f",
    name: "解除の宰相",
    alias: "いずれ現れる者ルク",
    mode: "hidden", // base は hidden、Phase で解除 → それでも広く隠す側（送らない）
  },
  open: {
    id: "id-open-c40d",
    name: "公開の剣聖",
    alias: "刹那のアキラ",
    mode: "mentioned",
  },
} as const;

const cand = (surface: string): CodexCandidate => ({
  surface,
  lemma: surface,
  count: 2,
  firstSceneId: "s1",
  context: "文脈",
});

async function put(entry: (typeof E)[keyof typeof E]) {
  await db.insert(codexEntries).values({
    id: entry.id,
    projectId: P1,
    type: "character",
    name: entry.name,
    aliases: JSON.stringify([entry.alias]),
    content: "{}",
    contextMode: entry.mode,
  });
}

async function putPhase(entryId: string, id: string, mode: string) {
  const now = new Date().toISOString();
  await db.insert(codexEntryPhases).values({
    id,
    entryId,
    anchorNodeId: null,
    label: id,
    contextModeOverride: mode,
    createdAt: now,
    updatedAt: now,
  });
}

function sentPrompt(): string {
  const messages = h.send.mock.calls[0]?.[0] as Array<{ content: string }>;
  return messages[0].content;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  publishCurrentProjectId(P1);
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
  const now = new Date().toISOString();
  await db.delete(codexEntryPhases);
  await db.delete(codexEntries);
  await db.delete(projects);
  await db
    .insert(projects)
    .values([
      { id: P1, title: "One", language: "ja", createdAt: now, updatedAt: now },
    ]);
  useTreeStore.setState({ projectId: P1 });
  h.send.mockReset();
  h.send.mockResolvedValue({
    text: JSON.stringify({
      judgments: [
        {
          surface: "新顔",
          suggestedType: "character",
          summary: "",
          aliasOfId: E.open.id,
        },
      ],
    }),
    inputTokens: 1,
    outputTokens: 1,
  });
});

describe("judgeCandidates × 実物の hidden 判定 × 実物の DB 層", () => {
  it("base が hidden・Phase でだけ hidden の項目の id・名前・別名は送られず、公開の項目は送られる", async () => {
    await put(E.baseHidden);
    await put(E.phaseHidden);
    await put(E.phaseReleased);
    await put(E.open);
    await putPhase(E.phaseHidden.id, "phase-hide-1", "hidden");
    await putPhase(E.phaseReleased.id, "phase-release-1", "mentioned");
    expect(useTreeStore.getState().projectId).toBe(P1);

    // 画面の entries（store）は hidden も含む。
    const entries = Object.values(E).map((e) => ({
      id: e.id,
      name: e.name,
      aliases: JSON.stringify([e.alias]),
    }));
    const result = await judgeCandidates([cand("新顔")], entries);

    // 空振りの緑を避けるため、送信が実際に 1 回あることを先に確かめる。
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][1]).toMatchObject({
      projectId: P1,
      pathId: "codex_judgment",
    });
    const prompt = sentPrompt();
    for (const hidden of [E.baseHidden, E.phaseHidden, E.phaseReleased]) {
      expect(prompt).not.toContain(hidden.id);
      expect(prompt).not.toContain(hidden.name);
      expect(prompt).not.toContain(hidden.alias);
    }
    expect(prompt).toContain(E.open.id);
    expect(prompt).toContain(E.open.name);
    expect(prompt).toContain(E.open.alias);
    // 公開の項目への別名判定は活きる。
    expect(result.get("新顔")?.aliasOfId).toBe(E.open.id);
  });

  it("DB に無い id（store が古い）も送られない", async () => {
    await put(E.open);
    await judgeCandidates(
      [cand("新顔")],
      [
        { id: E.open.id, name: E.open.name, aliases: null },
        { id: "id-ghost-77aa", name: "幽霊の項目", aliases: null },
      ],
    );

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentPrompt()).toContain(E.open.name);
    expect(sentPrompt()).not.toContain("幽霊の項目");
  });

  it("別 project の hidden でない項目は、project が合わず送られない", async () => {
    await put(E.open);
    useTreeStore.setState({ projectId: "judge-real-project-other" });

    await judgeCandidates(
      [cand("新顔")],
      [{ id: E.open.id, name: E.open.name, aliases: null }],
    );

    expect(sentPrompt()).not.toContain(E.open.id);
  });

  it("候補の表記（surface・lemma）が hidden の名前・別名と同じなら、その候補は送られない（entries に hidden を含む場合）", async () => {
    await put(E.baseHidden);
    await put(E.open);
    const entries = [E.baseHidden, E.open].map((e) => ({
      id: e.id,
      name: e.name,
      aliases: JSON.stringify([e.alias]),
    }));

    // hidden の別名と同じ候補だけなら、AI を呼ばず空の結果。
    expect(await judgeCandidates([cand(E.baseHidden.alias)], entries)).toEqual(
      new Map(),
    );
    expect(h.send).not.toHaveBeenCalled();

    // 一部だけ該当するなら、該当しない候補だけが送られる（名前・lemma 側の一致も除く）。
    await judgeCandidates(
      [
        cand(E.baseHidden.alias),
        { ...cand("活用形"), lemma: E.baseHidden.name },
        cand("新顔"),
      ],
      entries,
    );
    expect(h.send).toHaveBeenCalledTimes(1);
    const prompt = sentPrompt();
    expect(prompt).not.toContain(E.baseHidden.alias);
    expect(prompt).not.toContain(E.baseHidden.name);
    expect(prompt).not.toContain("活用形");
    expect(prompt).toContain("新顔");
  });

  it("Phase の contextModeOverride が不明な値の項目は送られない（DB の CHECK は不明値を許さないので、読みの結果を差し替えて固定する）", async () => {
    await put(E.open);
    await put(E.phaseHidden);
    const actual = phaseApi.listPhasesByEntryIds;
    vi.spyOn(phaseApi, "listPhasesByEntryIds").mockImplementation(
      async (ids) => [
        ...(await actual(ids)),
        {
          id: "phase-foo-1",
          entryId: E.phaseHidden.id,
          anchorNodeId: null,
          label: "foo",
          contextModeOverride: "foo",
        } as Awaited<ReturnType<typeof actual>>[number],
      ],
    );

    await judgeCandidates(
      [cand("新顔")],
      [E.open, E.phaseHidden].map((e) => ({
        id: e.id,
        name: e.name,
        aliases: JSON.stringify([e.alias]),
      })),
    );

    const prompt = sentPrompt();
    expect(prompt).not.toContain(E.phaseHidden.id);
    expect(prompt).not.toContain(E.phaseHidden.name);
    expect(prompt).toContain(E.open.id);
  });

  it("Phase の問い合わせ（判定の後半）が失敗したら、送らず reject する（fail-closed）", async () => {
    await put(E.open);
    await putPhase(E.open.id, "phase-open-1", "mentioned");
    vi.spyOn(phaseApi, "listPhasesByEntryIds").mockRejectedValue(
      new Error("phase query failed"),
    );

    await expect(
      judgeCandidates(
        [cand("新顔")],
        [{ id: E.open.id, name: E.open.name, aliases: null }],
      ),
    ).rejects.toMatchObject({ code: "CODEX_JUDGMENT_HIDDEN_CHECK_FAILED" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("projectId が無いときは AI を呼ばず reject する", async () => {
    await put(E.open);
    useTreeStore.setState({ projectId: undefined });

    await expect(
      judgeCandidates(
        [cand("新顔")],
        [{ id: E.open.id, name: E.open.name, aliases: null }],
      ),
    ).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("判定の間に project が切り替わったら、送らず reject する", async () => {
    await put(E.open);
    await putPhase(E.open.id, "phase-open-2", "mentioned");
    const actual = phaseApi.listPhasesByEntryIds;
    vi.spyOn(phaseApi, "listPhasesByEntryIds").mockImplementation(
      async (ids) => {
        useTreeStore.setState({ projectId: "judge-real-project-other" });
        return actual(ids);
      },
    );

    await expect(
      judgeCandidates(
        [cand("新顔")],
        [{ id: E.open.id, name: E.open.name, aliases: null }],
      ),
    ).rejects.toMatchObject({ code: "CODEX_JUDGMENT_PROJECT_CHANGED" });
    expect(h.send).not.toHaveBeenCalled();
  });

  it("項目が多い project（1 回の問い合わせの上限を超える数）でも、末尾の hidden まで判定して除く", async () => {
    const now = new Date().toISOString();
    const make = (i: number, mode: string) => ({
      id: `id-bulk-${String(i).padStart(4, "0")}-q`,
      projectId: P1,
      type: "character" as const,
      name: `大量${String(i).padStart(4, "0")}`,
      aliases: null,
      content: "{}",
      contextMode: mode,
      createdAt: now,
      updatedAt: now,
    });
    const rows = Array.from({ length: 1200 }, (_, i) =>
      make(i, i === 1150 ? "hidden" : "mentioned"),
    );
    for (let i = 0; i < rows.length; i += 200) {
      await db.insert(codexEntries).values(rows.slice(i, i + 200));
    }
    // 2 つ目の chunk（500〜999）にある項目を、Phase でだけ hidden にする。
    await putPhase(rows[700].id, "phase-bulk-1", "hidden");

    await judgeCandidates(
      [cand("新顔")],
      rows.map((r) => ({ id: r.id, name: r.name, aliases: null })),
    );

    const prompt = sentPrompt();
    expect(prompt).not.toContain(rows[1150].id);
    expect(prompt).not.toContain(rows[700].id);
    expect(prompt).toContain(rows[0].id);
  });
});
