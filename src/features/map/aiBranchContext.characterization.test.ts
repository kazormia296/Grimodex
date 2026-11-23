import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// 特性試験（実装の前に、今の挙動を固定する）。地図の AI Branch が AI へ送る種（seed）と
// Spotlight の形、prompt に載るもの、そして「base が hidden でなく Phase でだけ hidden の Codex は、
// 種にも pin にも入り、そのまま AI へ送られる」現状の穴を、送信の境界（invokeSingleShotChat）で固定する。
// 実装の commit で、穴の期待だけを反転する（DR-MP4-43）。

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
  collectAiBranchSeeds,
  fetchActiveSessionSpotlight,
} from "./aiBranchContext";
import {
  buildSystemPrompt,
  buildUserPrompt,
  generateAiBranchCards,
  type AiBranchSeed,
} from "./mapAiApi";

const P1 = "aibranch-char-project-1";
const SESSION = "aibranch-char-session-1";
const AUTHORITY = {
  projectId: P1,
  expectedWorkspacePath: "/ws",
  resourceId: "board-1",
  operationId: "op-1",
} as const;

type StoreEntry = {
  id: string;
  name: string;
  summary: string;
  content: string;
  contextMode: string;
};

function storeEntry(
  id: string,
  contextMode: string,
  over: Partial<StoreEntry> = {},
): StoreEntry {
  return {
    id,
    name: `name-${id}`,
    summary: `summary-${id}`,
    content: "",
    contextMode,
    ...over,
  };
}

function nodesOf(...ids: string[]): Node[] {
  return ids.map((id) => ({ id })) as Node[];
}

function setStores(opts: {
  codex?: StoreEntry[];
  tree?: Array<Record<string, unknown>>;
  snippets?: Array<Record<string, unknown>>;
}): void {
  useCodexStore.setState({ entries: opts.codex ?? [] } as never);
  useTreeStore.setState({ nodes: opts.tree ?? [] } as never);
  useSnippetStore.setState({ entries: opts.snippets ?? [] } as never);
}

function pm(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectAiBranchSeeds（同期の snapshot。今の形）", () => {
  beforeEach(() => {
    setStores({});
  });

  it("scene・note・sticky・snippet・ai_branch の seed の形と、store に無い id を飛ばすこと", () => {
    setStores({
      tree: [
        { id: "s1", title: "第一場", synopsis: "あらすじ" },
        { id: "s2", title: "", synopsis: "" },
        { id: "n1", title: "メモ", synopsis: "" },
      ],
      snippets: [{ id: "sn1", title: "断片", content: pm("断片の本文") }],
    });
    const stickies = [
      { id: "st1", title: "付箋", previewText: "", body: pm("付箋の本文") },
    ];
    const long = "あ".repeat(61);
    const branches = [
      { id: "b1", prompt: "短い依頼" },
      { id: "b2", prompt: long },
    ];
    const seeds = collectAiBranchSeeds(
      nodesOf(
        "scene:s1",
        "scene:s2",
        "note:n1",
        "scene:ghost",
        "sticky:st1",
        "sticky:ghost",
        "snippet:sn1",
        "ai_branch:b1",
        "ai_branch:b2",
        "ai_branch:ghost",
        "frame:f1",
      ),
      stickies as never,
      branches as never,
    );
    expect(seeds).toEqual([
      { type: "scene", title: "第一場", body: "あらすじ" },
      { type: "scene", title: "(無題)", body: undefined },
      { type: "note", title: "メモ", body: undefined },
      { type: "sticky", title: "付箋", body: "付箋の本文" },
      { type: "snippet", title: "断片", body: "断片の本文" },
      { type: "ai_branch", title: "短い依頼", body: undefined },
      { type: "ai_branch", title: "あ".repeat(60), body: long },
    ]);
  });

  it("Codex の seed：summary があれば summary、空なら本文、どちらも空なら body なし、名前が空なら「(無題)」", () => {
    setStores({
      codex: [
        storeEntry("a", "mentioned"),
        storeEntry("b", "mentioned", { summary: "  ", content: pm("本文b") }),
        storeEntry("c", "mentioned", { summary: "", content: "" }),
        storeEntry("d", "mentioned", { name: "" }),
      ],
    });
    const seeds = collectAiBranchSeeds(
      nodesOf("codex:a", "codex:b", "codex:c", "codex:d", "codex:ghost"),
      [],
      [],
    );
    expect(seeds).toEqual([
      { type: "codex", title: "name-a", body: "summary-a" },
      { type: "codex", title: "name-b", body: "本文b" },
      { type: "codex", title: "name-c", body: undefined },
      { type: "codex", title: "(無題)", body: "summary-d" },
    ]);
  });

  it("1500 字を超える本文は「…(以下省略)」付きで切る", () => {
    setStores({
      codex: [storeEntry("a", "mentioned", { summary: "あ".repeat(1600) })],
    });
    const [seed] = collectAiBranchSeeds(nodesOf("codex:a"), [], []);
    expect(seed.body).toBe("あ".repeat(1500) + "\n…(以下省略)");
  });

  it("base が hidden の Codex だけを除き、suppress は seed に残る（hidden だけを守る）", () => {
    setStores({
      codex: [
        storeEntry("h", "hidden"),
        storeEntry("s", "suppress"),
        storeEntry("m", "mentioned"),
        storeEntry("a", "always"),
      ],
    });
    const seeds = collectAiBranchSeeds(
      nodesOf("codex:h", "codex:s", "codex:m", "codex:a"),
      [],
      [],
    );
    expect(seeds.map((s) => s.title)).toEqual(["name-s", "name-m", "name-a"]);
  });
});

describe("fetchActiveSessionSpotlight（今の形）", () => {
  beforeEach(() => {
    setStores({});
    useChatStore.setState({ activeSessionId: SESSION } as never);
  });

  it("順序は Codex → Snippet → Sticky。base が hidden の pin は除き、suppress は残る", async () => {
    vi.spyOn(chatApi, "listPinnedCodexEntries").mockResolvedValue([
      storeEntry("h", "hidden"),
      storeEntry("s", "suppress"),
    ] as never);
    vi.spyOn(chatApi, "listPinnedSnippetEntries").mockResolvedValue([
      { id: "sn", title: "断片", content: pm("断片本文") },
    ] as never);
    vi.spyOn(chatApi, "listPinnedStickyEntries").mockResolvedValue([
      { id: "st", title: null, content: pm("付箋本文") },
    ] as never);
    const out = await fetchActiveSessionSpotlight();
    expect(out).toEqual([
      { type: "codex", title: "name-s", body: "summary-s" },
      { type: "snippet", title: "断片", body: "断片本文" },
      { type: "sticky", title: "(Sticky)", body: "付箋本文" },
    ]);
  });

  it("session が無いと空。pin の一覧取得が throw しても silent で空", async () => {
    vi.spyOn(chatApi, "listPinnedCodexEntries").mockRejectedValue(
      new Error("db down"),
    );
    vi.spyOn(chatApi, "listPinnedSnippetEntries").mockResolvedValue([]);
    vi.spyOn(chatApi, "listPinnedStickyEntries").mockResolvedValue([]);
    expect(await fetchActiveSessionSpotlight()).toEqual([]);
    useChatStore.setState({ activeSessionId: null } as never);
    expect(await fetchActiveSessionSpotlight()).toEqual([]);
  });
});

describe("prompt の組み立て（渡した seed の type・title・body だけが載る）", () => {
  it("seed の余分な項目（id など）は buildUserPrompt・buildSystemPrompt の出力に出ない", () => {
    const seeds = [
      {
        type: "codex",
        title: "題",
        body: "本文",
        codexEntryId: "id-leak-check-77",
      },
    ] as unknown as AiBranchSeed[];
    const user = buildUserPrompt("依頼", 3, seeds, "ja");
    const system = buildSystemPrompt(null, seeds);
    expect(user).toContain("題");
    expect(user).toContain("本文");
    expect(system).toContain("題");
    expect(user).not.toContain("id-leak-check-77");
    expect(system).not.toContain("id-leak-check-77");
  });
});

// 現状の穴：base が公開（mentioned）で、Phase の override が hidden の Codex は、種にも pin にも入り、
// 旧来の合成（collect＋Spotlight＋generate）で AI への送信に載る。地図は場面を持たないので、
// どの場面でも Phase で hidden になる項目は送らない側に揃える（DR-MP4-43。実装の commit で反転）。
describe("現状の穴（実 DB）：Phase でだけ hidden の Codex が AI へ送られる", () => {
  const E = {
    phaseHidden: {
      id: "id-char-phase-hidden-9d2e",
      name: "沈黙の司祭",
      summary: "後半で隠す者ゼノの概要",
      mode: "mentioned",
    },
    open: {
      id: "id-char-open-c40d",
      name: "公開の剣聖",
      summary: "刹那のアキラの概要",
      mode: "mentioned",
    },
  } as const;

  async function put(e: (typeof E)[keyof typeof E]) {
    await db.insert(codexEntries).values({
      id: e.id,
      projectId: P1,
      type: "character",
      name: e.name,
      summary: e.summary,
      content: "{}",
      contextMode: e.mode,
    });
  }

  beforeEach(async () => {
    publishCurrentProjectId(P1);
    installBrowserMock(
      await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
    );
    const now = new Date().toISOString();
    await db.delete(chatSessionPinnedCodex);
    await db.delete(chatSessions);
    await db.delete(codexEntryPhases);
    await db.delete(codexEntries);
    await db.delete(projects);
    await db.insert(projects).values([
      {
        id: P1,
        title: "One",
        language: "ja",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await put(E.phaseHidden);
    await put(E.open);
    await db.insert(codexEntryPhases).values({
      id: "phase-char-hide-1",
      entryId: E.phaseHidden.id,
      anchorNodeId: null,
      label: "第 3 章以降",
      contextModeOverride: "hidden",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(chatSessions).values({
      id: SESSION,
      projectId: P1,
      title: "s",
    });
    await db.insert(chatSessionPinnedCodex).values([
      { id: "pin-char-1", sessionId: SESSION, codexEntryId: E.phaseHidden.id },
      { id: "pin-char-2", sessionId: SESSION, codexEntryId: E.open.id },
    ]);
    setStores({
      codex: [
        storeEntry(E.phaseHidden.id, E.phaseHidden.mode, {
          name: E.phaseHidden.name,
          summary: E.phaseHidden.summary,
        }),
        storeEntry(E.open.id, E.open.mode, {
          name: E.open.name,
          summary: E.open.summary,
        }),
      ],
    });
    useChatStore.setState({ activeSessionId: SESSION } as never);
    h.send.mockReset();
    h.send.mockResolvedValue({
      blocks: [{ type: "text", content: "[]" }],
      stopReason: "end_turn",
    });
  });

  it("旧来の合成（collect＋Spotlight＋generate）では、Phase でだけ hidden の項目の名前・概要が送られる", async () => {
    const seeds = collectAiBranchSeeds(
      nodesOf(`codex:${E.phaseHidden.id}`, `codex:${E.open.id}`),
      [],
      [],
    );
    const spotlight = await fetchActiveSessionSpotlight();
    expect(seeds.map((s) => s.title)).toEqual([
      E.phaseHidden.name,
      E.open.name,
    ]);
    expect(spotlight.map((s) => s.title)).toEqual([
      E.phaseHidden.name,
      E.open.name,
    ]);

    await generateAiBranchCards(
      "依頼",
      3,
      seeds,
      null,
      spotlight,
      null,
      AUTHORITY,
    );

    // 空振りの緑を避けるため、送信が実際に 1 回あることを先に確かめる。
    expect(h.send).toHaveBeenCalledTimes(1);
    const messages = h.send.mock.calls[0][0].messages as Array<{
      content: string;
    }>;
    const sent = messages.map((m) => m.content).join("\n");
    expect(sent).toContain(E.phaseHidden.name);
    expect(sent).toContain(E.phaseHidden.summary);
    expect(sent).toContain(E.open.name);
  });
});
