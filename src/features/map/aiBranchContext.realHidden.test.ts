import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Node } from "@xyflow/react";
import { db } from "@/db/client";
import {
  chatSessionPinnedCodex,
  chatSessions,
  codexEntries,
  codexEntryPhases,
  projects,
} from "@/db/schema";
import { createBrowserMock } from "@/lib/browser-mock";
import { installBrowserMock } from "@/lib/tauri";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useChatStore } from "@/features/chat/chatStore";
import * as chatApi from "@/features/chat/chatApi";
import * as phaseApi from "@/features/codex/phaseApi";
import * as anyPhase from "@/features/codex/context/codexHiddenAnyPhase";
import * as hiddenFromAi from "@/features/codex/context/codexHiddenFromAi";

// 地図の AI Branch（runAiBranchGeneration）を、hidden の判定の実物と実物の DB 層（in-memory の
// sql.js）で通す（DR-MP4-43）。mock するのは AI へ出る境界（invokeSingleShotChat）と、試験環境で
// 無関係な gate・使用量の記録だけ。chatApi・phaseApi・codexStore の読みは実物。
//
// 地図は場面を持たないので、base が hidden の項目に加えて、どれかの Phase で hidden の項目
// （base は公開）も送らない。判定に失敗したら送らない（fail-closed）。各試験は、DR-MP4-43 の
// owner／lifecycle の行列（L1〜L9）に対応する。

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@/features/chat/singleShotTransport", () => ({
  invokeSingleShotChat: h.send,
}));
vi.mock("@/features/ai-policy/policyGuard", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/ai-policy/policyGuard")
  >()),
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/license/gate")>()),
  blockIfUnlicensed: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));

import {
  AiBranchHiddenCheckFailedError,
  buildAiBranchSeedChipMeta,
  collectAiBranchSeeds,
  listAiBranchCodexIdsNotSent,
  runAiBranchGeneration,
  type AiBranchSeedSource,
} from "./aiBranchContext";
import * as mapAiApi from "./mapAiApi";

const P1 = "aibranch-real-project-1";
const P2 = "aibranch-real-project-2";
const SESSION = "aibranch-real-session-1";
const AUTHORITY = {
  projectId: P1,
  expectedWorkspacePath: "/ws",
  resourceId: "board-1",
  operationId: "op-1",
} as const;

// id・名前・概要は、prompt の定型文や互いの部分文字列にならない固有の文字列にする。
type Fx = {
  id: string;
  name: string;
  summary: string;
  body: string; // content の本文（summary が空のとき seed の本文になる）
  mode: string;
  project?: string;
};
const E = {
  baseHidden: {
    id: "id-base-hidden-5a1c",
    name: "秘匿の帝都",
    summary: "影の都ヴォルグの概要",
    body: "",
    mode: "hidden",
  },
  phaseHidden: {
    id: "id-phase-hidden-9d2e",
    name: "沈黙の司祭",
    summary: "後半で隠す者ゼノの概要",
    body: "",
    mode: "mentioned",
  },
  phaseHiddenBody: {
    id: "id-phase-hidden-body-4e8a",
    name: "夜の書記官",
    summary: "",
    body: "本文だけにある書記官ロウの秘密",
    mode: "always",
  },
  phaseReleased: {
    id: "id-phase-released-3b7f",
    name: "解除の宰相",
    summary: "いずれ現れる者ルクの概要",
    body: "",
    mode: "hidden", // base は hidden、Phase で解除 → それでも広く隠す側（送らない）
  },
  open: {
    id: "id-open-c40d",
    name: "公開の剣聖",
    summary: "刹那のアキラの概要",
    body: "",
    mode: "mentioned",
  },
  suppressOnly: {
    id: "id-suppress-only-81f0",
    name: "沈む塔の番人",
    summary: "潮騒のカイの概要",
    body: "",
    mode: "mentioned", // Phase の override は suppress だけ → hidden にしない（広げない）
  },
  otherProject: {
    id: "id-other-project-66d2",
    name: "別の物語の王",
    summary: "別 project の概要",
    body: "",
    mode: "mentioned",
    project: P2,
  },
} satisfies Record<string, Fx>;

const NON_CODEX: AiBranchSeedSource[] = [
  { type: "scene", title: "第一場の題", body: "第一場のあらすじ" },
  { type: "sticky", title: "付箋の題" },
  { type: "ai_branch", title: "前の依頼の題" },
];

function pm(text: string): string {
  return text
    ? JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      })
    : "";
}

async function put(e: Fx): Promise<void> {
  await db.insert(codexEntries).values({
    id: e.id,
    projectId: e.project ?? P1,
    type: "character",
    name: e.name,
    summary: e.summary,
    content: pm(e.body) || "{}",
    contextMode: e.mode,
  });
}

async function putPhase(
  entryId: string,
  id: string,
  mode: string,
): Promise<void> {
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

async function pin(entryId: string, id: string): Promise<void> {
  await db
    .insert(chatSessionPinnedCodex)
    .values({ id, sessionId: SESSION, codexEntryId: entryId });
}

/** 画面の store（古いことがある）。DB の mode と別にしたいとき storeMode で上書きする。 */
function storeEntry(e: Fx, storeMode?: string) {
  return {
    id: e.id,
    name: e.name,
    summary: e.summary,
    content: pm(e.body),
    contextMode: storeMode ?? e.mode,
  };
}

function setCodexStore(entries: ReturnType<typeof storeEntry>[]): void {
  useCodexStore.setState({ entries } as never);
}

function nodesOf(...ids: string[]): Node[] {
  return ids.map((id) => ({ id })) as Node[];
}

function codexNodes(...fx: Fx[]): Node[] {
  return nodesOf(...fx.map((f) => `codex:${f.id}`));
}

function sentText(call = 0): string {
  const messages = h.send.mock.calls[call]?.[0].messages as Array<{
    content: string;
  }>;
  return messages.map((m) => m.content).join("\n");
}

/** spy の最初の呼びの引数（呼ばれていなければ試験を落とす）。 */
function firstCall<A extends unknown[]>(spy: { mock: { calls: A[] } }): A {
  const call = spy.mock.calls[0];
  if (!call) throw new Error("expected the spy to have been called");
  return call;
}

function generateSpy() {
  return vi.spyOn(mapAiApi, "generateAiBranchCards");
}

async function run(
  seeds: readonly AiBranchSeedSource[],
  over: Partial<Parameters<typeof runAiBranchGeneration>[0]> = {},
) {
  return runAiBranchGeneration({
    prompt: "依頼",
    count: 3,
    seeds,
    vs: null,
    authority: AUTHORITY,
    assertAuthority: () => {},
    ...over,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// sql.js の DB は試験ごとに作り直すとメモリが尽きる（OOM）。1 回だけ作り、表の中身を消して使う。
beforeAll(async () => {
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
});

beforeEach(async () => {
  publishCurrentProjectId(P1);
  const now = new Date().toISOString();
  await db.delete(chatSessionPinnedCodex);
  await db.delete(chatSessions);
  await db.delete(codexEntryPhases);
  await db.delete(codexEntries);
  await db.delete(projects);
  await db.insert(projects).values(
    [P1, P2].map((id) => ({
      id,
      title: id,
      language: "ja",
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db
    .insert(chatSessions)
    .values({ id: SESSION, projectId: P1, title: "s" });
  useTreeStore.setState({ projectId: P1, nodes: [] } as never);
  useSnippetStore.setState({ entries: [] } as never);
  useChatStore.setState({ activeSessionId: SESSION } as never);
  setCodexStore([]);
  h.send.mockReset();
  h.send.mockResolvedValue({
    blocks: [{ type: "text", content: "[]" }],
    stopReason: "end_turn",
  });
});

async function putAll(): Promise<void> {
  for (const e of Object.values(E) as Fx[]) await put(e);
  await putPhase(E.phaseHidden.id, "phase-hide-1", "hidden");
  await putPhase(E.phaseHiddenBody.id, "phase-hide-2", "hidden");
  await putPhase(E.phaseReleased.id, "phase-release-1", "mentioned");
  await putPhase(E.suppressOnly.id, "phase-suppress-1", "suppress");
}

describe("L1 入口と判定：seed・Spotlight の hidden（実物の判定・実物の DB 層）", () => {
  it("base が hidden・Phase でだけ hidden の項目は、seed にも pin にも載らず、公開・suppress だけの Phase の項目は載る", async () => {
    await putAll();
    const all = (Object.values(E) as Fx[]).filter((e) => !e.project);
    for (const [i, e] of all.entries()) await pin(e.id, `pin-${i}`);
    setCodexStore(all.map((e) => storeEntry(e)));
    const seeds = collectAiBranchSeeds(codexNodes(...all), [], []);
    // 同期の層（store の base の mode だけ）では、Phase でだけ hidden の項目はまだ残る。
    expect(seeds.map((s) => s.title)).toContain(E.phaseHidden.name);

    await run([...NON_CODEX, ...seeds]);

    // 空振りの緑を避けるため、送信が実際に 1 回あることを先に確かめる。
    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = sentText();
    for (const hidden of [
      E.baseHidden,
      E.phaseHidden,
      E.phaseHiddenBody,
      E.phaseReleased,
    ]) {
      expect(sent).not.toContain(hidden.id);
      expect(sent).not.toContain(hidden.name);
      if (hidden.summary) expect(sent).not.toContain(hidden.summary);
      if (hidden.body) expect(sent).not.toContain(hidden.body);
    }
    for (const visible of [E.open, E.suppressOnly]) {
      // seed（ユーザープロンプト）と pin（システムプロンプト）の両方に載る。
      const occurrences = sent.split(visible.name).length - 1;
      expect(occurrences).toBe(2);
      expect(sent).toContain(visible.summary);
    }
    for (const s of NON_CODEX) expect(sent).toContain(s.title);
  });

  it("送信に渡る seed・Spotlight は type・title・body だけを持ち、codexEntryId を持たない", async () => {
    await putAll();
    await pin(E.open.id, "pin-open");
    setCodexStore([storeEntry(E.open)]);
    const spy = generateSpy();
    await run([
      ...NON_CODEX,
      ...collectAiBranchSeeds(codexNodes(E.open), [], []),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const [, , seeds = [], , spotlight = []] = firstCall(spy);
    expect(seeds.length).toBe(4);
    expect(spotlight.length).toBe(1);
    for (const s of [...seeds, ...spotlight]) {
      expect(
        Object.keys(s).every((k) => ["type", "title", "body"].includes(k)),
      ).toBe(true);
    }
  });

  it("store が古い（DB では hidden）項目、DB に無い id、別 project の pin は落ちる", async () => {
    await put(E.baseHidden);
    await put(E.open);
    await put(E.otherProject);
    await pin(E.otherProject.id, "pin-other");
    // store は baseHidden を公開と思っている（古い）。DB に無い幽霊の項目も持つ。
    const ghost: Fx = {
      id: "id-ghost-77aa",
      name: "幽霊の項目",
      summary: "幽霊の概要",
      body: "",
      mode: "mentioned",
    };
    setCodexStore([
      storeEntry(E.baseHidden, "mentioned"),
      storeEntry(E.open),
      storeEntry(ghost),
    ]);
    const seeds = collectAiBranchSeeds(
      codexNodes(E.baseHidden, E.open, ghost),
      [],
      [],
    );
    expect(seeds.length).toBe(3);

    await run(seeds);

    expect(h.send).toHaveBeenCalledTimes(1);
    const sent = sentText();
    expect(sent).toContain(E.open.name);
    for (const gone of [E.baseHidden, ghost, E.otherProject]) {
      expect(sent).not.toContain(gone.name);
      expect(sent).not.toContain(gone.summary);
    }
  });

  it("H2（listCodexIdsHiddenFromAi）が空を返しても、Phase でだけ hidden の項目は落ちる（広く隠す側）", async () => {
    await put(E.phaseHidden);
    await put(E.open);
    await putPhase(E.phaseHidden.id, "phase-hide-1", "hidden");
    vi.spyOn(hiddenFromAi, "listCodexIdsHiddenFromAi").mockResolvedValue(
      new Set(),
    );
    setCodexStore([storeEntry(E.phaseHidden), storeEntry(E.open)]);
    await run(collectAiBranchSeeds(codexNodes(E.phaseHidden, E.open), [], []));
    expect(sentText()).not.toContain(E.phaseHidden.name);
    expect(sentText()).toContain(E.open.name);
  });

  it("seed と pin の Codex は 1 回の判定にまとめ、1,001 件（500・500・1 の分割）でも末尾の hidden まで落ちる", async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: `id-bulk-${i}`,
      projectId: P1,
      type: "character",
      name: `大量${i}番`,
      summary: `大量の概要${i}`,
      content: "{}",
      contextMode: i === 0 || i === 1000 ? "hidden" : "mentioned",
    }));
    for (let i = 0; i < rows.length; i += 50) {
      await db.insert(codexEntries).values(rows.slice(i, i + 50));
    }
    const seeds: AiBranchSeedSource[] = rows.map((r) => ({
      type: "codex",
      title: r.name,
      body: r.summary,
      codexEntryId: r.id,
    }));
    const spy = vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase");
    await run(seeds);
    expect(spy).toHaveBeenCalledTimes(1);
    const sent = sentText();
    expect(sent).not.toContain("大量0番");
    expect(sent).not.toContain("大量1000番");
    expect(sent).toContain("大量1番");
    expect(sent).toContain("大量999番");
  });
});

describe("L2 全部の種が除かれる・Codex が無い", () => {
  it("選んだ種が全部除かれたら、種なしで送信 1 回（中止しない）", async () => {
    await put(E.baseHidden);
    await put(E.phaseHidden);
    await putPhase(E.phaseHidden.id, "phase-hide-1", "hidden");
    setCodexStore([
      storeEntry(E.baseHidden, "mentioned"),
      storeEntry(E.phaseHidden),
    ]);
    const spy = generateSpy();
    await run(
      collectAiBranchSeeds(codexNodes(E.baseHidden, E.phaseHidden), [], []),
    );
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(firstCall(spy)[2]).toEqual([]);
    expect(sentText()).not.toContain(E.baseHidden.name);
    expect(sentText()).not.toContain(E.phaseHidden.name);
  });

  it("Codex が 0 件（seed も pin も）なら、判定を呼ばず、失敗もせず、非 Codex の seed は順序どおり全部残る", async () => {
    const spy = vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase");
    const gen = generateSpy();
    await run(NON_CODEX);
    expect(spy).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(firstCall(gen)[2]).toEqual(NON_CODEX);
  });

  it("除去しても順序は保たれる（Set の順にならない）", async () => {
    await put(E.open);
    await put(E.suppressOnly);
    await put(E.baseHidden);
    setCodexStore([
      storeEntry(E.open),
      storeEntry(E.suppressOnly),
      storeEntry(E.baseHidden, "mentioned"),
    ]);
    const gen = generateSpy();
    const codex = collectAiBranchSeeds(
      codexNodes(E.suppressOnly, E.baseHidden, E.open),
      [],
      [],
    );
    await run([NON_CODEX[0], ...codex, NON_CODEX[1]]);
    expect((firstCall(gen)[2] ?? []).map((s) => s.title)).toEqual([
      NON_CODEX[0].title,
      E.suppressOnly.name,
      E.open.name,
      NON_CODEX[1].title,
    ]);
  });

  it("id を持たない Codex の種は、由来を確かめられないので送らない", async () => {
    const gen = generateSpy();
    await run([...NON_CODEX, { type: "codex", title: "由来不明", body: "x" }]);
    expect(firstCall(gen)[2]).toEqual(NON_CODEX);
  });
});

describe("L3 判定の失敗は送らず中止（fail-closed）", () => {
  it("判定が reject したら AiBranchHiddenCheckFailedError で reject し、送信 0 回・非 Codex の seed も消えない", async () => {
    await put(E.open);
    setCodexStore([storeEntry(E.open)]);
    vi.spyOn(phaseApi, "listPhasesByEntryIds").mockRejectedValue(
      new Error("db down"),
    );
    const gen = generateSpy();
    const seeds = [
      ...NON_CODEX,
      ...collectAiBranchSeeds(codexNodes(E.open), [], []),
    ];
    await expect(run(seeds)).rejects.toBeInstanceOf(
      AiBranchHiddenCheckFailedError,
    );
    expect(gen).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("pin だけが Codex のときの判定の失敗も、送信 0 回", async () => {
    await put(E.open);
    await pin(E.open.id, "pin-open");
    vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase").mockRejectedValue(
      new Error("boom"),
    );
    await expect(run(NON_CODEX)).rejects.toBeInstanceOf(
      AiBranchHiddenCheckFailedError,
    );
    expect(h.send).not.toHaveBeenCalled();
  });

  it("pin の一覧取得の失敗は従来どおり silent（Spotlight が空になるだけで、送信は 1 回）", async () => {
    vi.spyOn(chatApi, "listPinnedCodexEntries").mockRejectedValue(
      new Error("db down"),
    );
    await run(NON_CODEX);
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("projectId が空なら、何も読まず、送信 0 回で reject する", async () => {
    const pins = vi.spyOn(chatApi, "listPinnedCodexEntries");
    const judge = vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase");
    for (const projectId of ["", "   "]) {
      await expect(
        run(NON_CODEX, { authority: { ...AUTHORITY, projectId } }),
      ).rejects.toBeInstanceOf(AiBranchHiddenCheckFailedError);
    }
    expect(pins).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("L4 admission の閉鎖：authority の検査は判定の後・送信の前", () => {
  it("順序は 判定 → assertAuthority → 送信。assertAuthority が throw したら送信 0 回", async () => {
    await put(E.open);
    await pin(E.open.id, "pin-open");
    const order: string[] = [];
    const real = anyPhase.listCodexIdsHiddenFromAiInAnyPhase;
    vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase").mockImplementation(
      async (input) => {
        const out = await real(input);
        order.push("judge");
        return out;
      },
    );
    h.send.mockImplementation(async () => {
      order.push("send");
      return { blocks: [{ type: "text", content: "[]" }], stopReason: "x" };
    });
    await run(NON_CODEX, { assertAuthority: () => order.push("assert") });
    expect(order).toEqual(["judge", "assert", "send"]);

    order.length = 0;
    h.send.mockClear();
    await expect(
      run(NON_CODEX, {
        assertAuthority: () => {
          order.push("assert");
          throw new Error("board changed");
        },
      }),
    ).rejects.toThrow("board changed");
    expect(order).toEqual(["judge", "assert"]);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("L5 再入：各実行は自分の判定の後にだけ送り、判定の結果を共有しない", () => {
  it("2 本を並行に走らせ、判定が返るまで送信 0 回。送信はそれぞれ自分の判定の結果を使う", async () => {
    await put(E.open);
    await put(E.suppressOnly);
    const calls: Array<{
      input: { entryIds: readonly string[] };
      resolve: (v: Set<string>) => void;
    }> = [];
    vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase").mockImplementation(
      (input) =>
        new Promise<Set<string>>((resolve) => {
          calls.push({ input, resolve });
        }),
    );
    const seeds = (): AiBranchSeedSource[] => [
      {
        type: "codex",
        title: E.open.name,
        body: E.open.summary,
        codexEntryId: E.open.id,
      },
      {
        type: "codex",
        title: E.suppressOnly.name,
        body: E.suppressOnly.summary,
        codexEntryId: E.suppressOnly.id,
      },
    ];
    const a = run(seeds());
    const b = run(seeds());
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(h.send).not.toHaveBeenCalled();

    // B の判定だけ先に返す（open を hidden とする）。A はまだ送らない。
    calls[1].resolve(new Set([E.open.id]));
    await b;
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentText(0)).not.toContain(E.open.name);
    expect(sentText(0)).toContain(E.suppressOnly.name);

    // A は自分の判定（hidden なし）で送る。B の結果を引き継がない。
    calls[0].resolve(new Set());
    await a;
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(sentText(1)).toContain(E.open.name);
    expect(sentText(1)).toContain(E.suppressOnly.name);
  });
});

describe("L6 project の切替：判定の最中に切り替わっても、切替前の project の authority で送らない", () => {
  it("判定が返った後に assertAuthority が切替を検出して throw すると、送信 0 回", async () => {
    await put(E.open);
    setCodexStore([storeEntry(E.open)]);
    let switched = false;
    const real = anyPhase.listCodexIdsHiddenFromAiInAnyPhase;
    vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase").mockImplementation(
      async (input) => {
        const out = await real(input);
        switched = true; // 判定の最中に project が切り替わった
        return out;
      },
    );
    await expect(
      run(collectAiBranchSeeds(codexNodes(E.open), [], []), {
        assertAuthority: () => {
          if (switched) throw new Error("project changed");
        },
      }),
    ).rejects.toThrow("project changed");
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe("L7 配線：generateAiBranchCards の呼び元は runAiBranchGeneration だけ（補助の静的照合）", () => {
  // 振る舞いの試験（上）が主。MapCanvas の描画の試験は無いので、呼び元が判定を通らずに
  // 送る形に戻っていないかを、文字列で補助的に見る。落ちたら、送信の直前に hidden の判定
  // （prepareAiBranchSendContext）を通らない経路が生えていないか確かめる。
  const SRC = join(__dirname, "..", "..");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) out.push(...sourceFiles(p));
      else if (/\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name))
        out.push(p);
    }
    return out;
  }

  it("src の中で generateAiBranchCards を import する非試験の file は、aiBranchContext.ts だけ", () => {
    const importsIt =
      /import\s*(?:type\s*)?\{[^}]*\bgenerateAiBranchCards\b[^}]*\}\s*from/;
    const users = sourceFiles(SRC)
      .filter((f) => importsIt.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).split("\\").join("/"))
      .sort();
    expect(users).toEqual(["features/map/aiBranchContext.ts"]);
  });

  it("MapCanvas は runAiBranchGeneration を呼び、project 文脈・pin の取得を自分では呼ばない", () => {
    const src = readFileSync(
      join(SRC, "features", "map", "MapCanvas.tsx"),
      "utf8",
    );
    expect(src).toMatch(/await runAiBranchGeneration\(\{/);
    expect(src).not.toMatch(/fetchActiveSessionSpotlight/);
    expect(src).not.toMatch(/fetchAiBranchProjectContext/);
    // 判定の失敗は専用の枝で、画面には原因の文を出さず既存の題名だけ。
    expect(src).toMatch(/instanceof AiBranchHiddenCheckFailedError/);
  });

  it("MapCanvas は注記の判定に dialog の authority の projectId を渡し、chip の題と meta を同じ chips から作って dialog に渡す（補助の静的照合）", () => {
    const src = readFileSync(
      join(SRC, "features", "map", "MapCanvas.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /listAiBranchCodexIdsNotSent\(\{\s*projectId: aiBranchDialog\.authority\.projectId,\s*entryIds,?\s*\}\)/,
    );
    expect(src).toMatch(/meta: buildAiBranchSeedChipMeta\(n\.id, seeds\)/);
    expect(src).toMatch(/seedNodeTitles = chips\.map\(\(c\) => c\.title\)/);
    expect(src).toMatch(/seedChipMeta = chips\.map\(\(c\) => c\.meta\)/);
    expect(src).toMatch(/seedChipMeta=\{aiBranchDialog\.seedChipMeta\}/);
  });

  it("MapCanvas の assertAuthority は、実物の assertAiOperationAuthorityCurrent を live の project id で呼ぶ closure を渡す（L4・L10 の配線の静的照合）", () => {
    const src = readFileSync(
      join(SRC, "features", "map", "MapCanvas.tsx"),
      "utf8",
    );
    expect(src).toMatch(/assertAuthority: assertDialogAuthority/);
    expect(src).toMatch(
      /assertAiOperationAuthorityCurrent\(\s*dialogState\.authority,\s*getCurrentProjectId\(\),?\s*\)/,
    );
  });
});

describe("L14 確認ダイアログの注記の判定：送信の直前の判定と同じ部品・同じ規則（実物の判定・実物の DB 層）", () => {
  const GHOST_ID = "id-ghost-notsent-12ab";

  async function putFixtures(): Promise<void> {
    await putAll();
  }

  const ALL_IDS = () => [
    ...(Object.values(E) as Fx[]).map((e) => e.id),
    GHOST_ID,
  ];

  it("Phase でだけ hidden・base が hidden・解除の Phase・DB に無い id・別 project は「送られない」、公開と suppress だけの Phase の項目は含まない", async () => {
    await putFixtures();
    const notSent = await listAiBranchCodexIdsNotSent({
      projectId: P1,
      entryIds: ALL_IDS(),
    });
    expect([...notSent].sort()).toEqual(
      [
        E.baseHidden.id,
        E.phaseHidden.id,
        E.phaseHiddenBody.id,
        E.phaseReleased.id,
        E.otherProject.id,
        GHOST_ID,
      ].sort(),
    );
    expect(notSent.has(E.open.id)).toBe(false);
    expect(notSent.has(E.suppressOnly.id)).toBe(false);
  });

  it("注記の判定と、送信の直前の判定は同じ結果になる（注記の対象 = 実際に送信から落ちる Codex）", async () => {
    await putFixtures();
    const fx = (Object.values(E) as Fx[]).filter((e) => !e.project);
    setCodexStore(fx.map((e) => storeEntry(e)));
    // store の mode は DB と同じにして、同期の層で落ちる項目（base hidden）も同じ集合に入ることを見る。
    const nodes = codexNodes(...fx);
    const seeds = collectAiBranchSeeds(nodes, [], []);
    const notSent = await listAiBranchCodexIdsNotSent({
      projectId: P1,
      entryIds: fx.map((e) => e.id),
    });

    await run(seeds);

    const sent = sentText();
    for (const e of fx) {
      // 名前が送信に載らない Codex だけが、注記の対象。
      expect(sent.includes(e.name)).toBe(!notSent.has(e.id));
    }
    // chip の情報：同期の層で外れた Codex（base が hidden）は notSentLocally、他は DB の判定に任せる。
    const metas = nodes.map((n) => buildAiBranchSeedChipMeta(n.id, seeds));
    const locally = fx
      .filter((_, i) => metas[i]?.notSentLocally)
      .map((e) => e.id);
    // base が hidden の 2 件（解除の Phase を持つ項目も、base は hidden）。
    expect(locally).toEqual([E.baseHidden.id, E.phaseReleased.id]);
  });

  it("Codex 以外のノードは chip の情報が無く、種に載らない Codex（store に無い）は notSentLocally", () => {
    expect(buildAiBranchSeedChipMeta("sticky:s1", [])).toBeUndefined();
    expect(buildAiBranchSeedChipMeta("scene:x", [])).toBeUndefined();
    expect(buildAiBranchSeedChipMeta("codex:c1", [])).toEqual({
      codexEntryId: "c1",
      notSentLocally: true,
    });
    expect(
      buildAiBranchSeedChipMeta("codex:c1", [
        { type: "codex", title: "t", codexEntryId: "c1" },
      ]),
    ).toEqual({ codexEntryId: "c1", notSentLocally: false });
  });

  it("id が 0 件なら DB を読まず空、projectId が空なら reject、DB の読みの失敗は reject する", async () => {
    const spy = vi.spyOn(anyPhase, "listCodexIdsHiddenFromAiInAnyPhase");
    expect(
      (await listAiBranchCodexIdsNotSent({ projectId: P1, entryIds: [] })).size,
    ).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    await expect(
      listAiBranchCodexIdsNotSent({ projectId: " ", entryIds: ["x"] }),
    ).rejects.toBeInstanceOf(AiBranchHiddenCheckFailedError);
    spy.mockRejectedValueOnce(new Error("db down"));
    await expect(
      listAiBranchCodexIdsNotSent({ projectId: P1, entryIds: ["x"] }),
    ).rejects.toThrow("db down");
  });

  it("注記の判定が失敗しても、送信の判定は独立に効く（hidden は送られない）", async () => {
    await putFixtures();
    setCodexStore([storeEntry(E.phaseHidden), storeEntry(E.open)]);
    const seeds = collectAiBranchSeeds(
      codexNodes(E.phaseHidden, E.open),
      [],
      [],
    );
    // 注記の判定だけが 1 回失敗する。
    vi.spyOn(
      anyPhase,
      "listCodexIdsHiddenFromAiInAnyPhase",
    ).mockRejectedValueOnce(new Error("db down"));
    await expect(
      listAiBranchCodexIdsNotSent({
        projectId: P1,
        entryIds: [E.phaseHidden.id],
      }),
    ).rejects.toThrow("db down");
    await run(seeds);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(sentText()).not.toContain(E.phaseHidden.name);
    expect(sentText()).toContain(E.open.name);
  });
});
