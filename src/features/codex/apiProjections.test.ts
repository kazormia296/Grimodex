import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/db/client";
import { projects, codexEntries } from "@/db/schema";
import {
  listCodexMatchTargets,
  listCodexEntriesForContext,
  listCodexContextMetadata,
  listCodexEntriesForContextByIds,
  listCodexContentsForBaseline,
} from "./api";

// M10: listCodexEntries の用途別 projection API を実 DB (browser-mock in-memory
// SQLite) で検証する。重い列 (icon / notes) が戻り行に含まれないこと・必要列が
// 欠けないこと・project / type スコープが効くことを regression guard する。

const PROJECT_A = "m10-proj-a";
const PROJECT_B = "m10-proj-b";

const ICON_A = "data:image/webp;base64,AAAA";
const NOTES_A = '{"type":"doc","content":[{"type":"paragraph"}]}';
const CONTENT_A =
  '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"アリスの本文"}]}]}';

beforeAll(async () => {
  const now = new Date().toISOString();
  for (const id of [PROJECT_A, PROJECT_B]) {
    await db
      .insert(projects)
      .values({ id, title: id, createdAt: now, updatedAt: now });
    // The canonical project trigger seeds character/location before entries
    // are inserted, satisfying the composite foreign key.
  }
  await db.insert(codexEntries).values([
    {
      id: "m10-alice",
      projectId: PROJECT_A,
      type: "character",
      name: "アリス",
      aliases: '["ありす"]',
      excludedAliases: '["蟻巣"]',
      readings: '{"アリス":["ありす"]}',
      summary: "主人公",
      content: CONTENT_A,
      icon: ICON_A,
      notes: NOTES_A,
      tagsCache: '[{"name":"主役","color":null}]',
      contextMode: "always",
      childrenBudget: "standard",
    },
    {
      id: "m10-forest",
      projectId: PROJECT_A,
      type: "location",
      name: "迷いの森",
    },
    {
      id: "m10-bob",
      projectId: PROJECT_B,
      type: "character",
      name: "ボブ",
    },
  ]);
});

describe("listCodexMatchTargets", () => {
  it("ローカル照合用の軽量列だけを返す (icon/notes/content を含まない)", async () => {
    const rows = await listCodexMatchTargets(PROJECT_A);
    const alice = rows.find((r) => r.id === "m10-alice");
    expect(alice).toBeDefined();
    expect(Object.keys(alice!).sort()).toEqual(
      ["aliases", "excludedAliases", "id", "name", "readings", "type"].sort(),
    );
    expect(alice!.name).toBe("アリス");
    expect(alice!.type).toBe("character");
    expect(alice!.aliases).toBe('["ありす"]');
    expect(alice!.excludedAliases).toBe('["蟻巣"]');
    expect(alice!.readings).toBe('{"アリス":["ありす"]}');
  });

  it("project / type スコープが効く", async () => {
    const a = await listCodexMatchTargets(PROJECT_A);
    expect(a.map((r) => r.id).sort()).toEqual(["m10-alice", "m10-forest"]);

    const aChars = await listCodexMatchTargets(PROJECT_A, "character");
    expect(aChars.map((r) => r.id)).toEqual(["m10-alice"]);

    const b = await listCodexMatchTargets(PROJECT_B);
    expect(b.map((r) => r.id)).toEqual(["m10-bob"]);
  });
});

describe("listCodexEntriesForContext", () => {
  it("icon と notes を含まないが content 等の文脈列は保持する", async () => {
    const rows = await listCodexEntriesForContext(PROJECT_A);
    const alice = rows.find((r) => r.id === "m10-alice");
    expect(alice).toBeDefined();
    const keys = Object.keys(alice!);
    expect(keys).not.toContain("icon");
    expect(keys).not.toContain("notes");
    // L4 注入・mention 検出・子孫 BFS が消費する列は全部残っていること。
    expect(alice!.content).toBe(CONTENT_A);
    expect(alice!.summary).toBe("主人公");
    expect(alice!.contextMode).toBe("always");
    expect(alice!.childrenBudget).toBe("standard");
    expect(alice!.parentId).toBeNull();
    expect(alice!.aliases).toBe('["ありす"]');
    expect(alice!.excludedAliases).toBe('["蟻巣"]');
    expect(alice!.tagsCache).toBe('[{"name":"主役","color":null}]');
    expect(alice!.projectId).toBe(PROJECT_A);
    expect(typeof alice!.updatedAt).toBe("string");
    expect(typeof alice!.version).toBe("number");
  });

  it("project / type スコープが効く", async () => {
    const a = await listCodexEntriesForContext(PROJECT_A);
    expect(a.map((r) => r.id).sort()).toEqual(["m10-alice", "m10-forest"]);

    const aLoc = await listCodexEntriesForContext(PROJECT_A, "location");
    expect(aLoc.map((r) => r.id)).toEqual(["m10-forest"]);

    const b = await listCodexEntriesForContext(PROJECT_B);
    expect(b.map((r) => r.id)).toEqual(["m10-bob"]);
  });
});

describe("listCodexContextMetadata", () => {
  it("AI 文脈候補用に content/icon/notes を含まない", async () => {
    const rows = await listCodexContextMetadata(PROJECT_A);
    const alice = rows.find((r) => r.id === "m10-alice");
    expect(alice).toBeDefined();
    const keys = Object.keys(alice!);
    expect(keys).not.toContain("content");
    expect(keys).not.toContain("icon");
    expect(keys).not.toContain("notes");
    expect(alice!.summary).toBe("主人公");
    expect(alice!.contextMode).toBe("always");
    expect(alice!.childrenBudget).toBe("standard");
    expect(alice!.projectId).toBe(PROJECT_A);
  });

  it("project / type スコープが効く", async () => {
    const a = await listCodexContextMetadata(PROJECT_A);
    expect(a.map((r) => r.id).sort()).toEqual(["m10-alice", "m10-forest"]);

    const aChars = await listCodexContextMetadata(PROJECT_A, "character");
    expect(aChars.map((r) => r.id)).toEqual(["m10-alice"]);

    const b = await listCodexContextMetadata(PROJECT_B);
    expect(b.map((r) => r.id)).toEqual(["m10-bob"]);
  });
});

describe("listCodexEntriesForContextByIds", () => {
  it("指定IDだけ content 付きで返し、入力順を保つ", async () => {
    const rows = await listCodexEntriesForContextByIds(PROJECT_A, [
      "m10-forest",
      "m10-alice",
      "m10-forest",
      "missing",
    ]);
    expect(rows.map((row) => row.id)).toEqual(["m10-forest", "m10-alice"]);
    expect(rows[1]!.content).toBe(CONTENT_A);
  });

  it("空IDではDB projection結果を返さない", async () => {
    await expect(
      listCodexEntriesForContextByIds(PROJECT_A, []),
    ).resolves.toEqual([]);
  });
});

describe("listCodexContentsForBaseline", () => {
  it("id と content の 2 列だけを返す", async () => {
    const rows = await listCodexContentsForBaseline(PROJECT_A);
    expect(rows.map((r) => r.id).sort()).toEqual(["m10-alice", "m10-forest"]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["content", "id"]);
    }
    const alice = rows.find((r) => r.id === "m10-alice");
    expect(alice!.content).toBe(CONTENT_A);
    // content は NOT NULL default '{}' — 未設定エントリも文字列で返る。
    const forest = rows.find((r) => r.id === "m10-forest");
    expect(forest!.content).toBe("{}");
  });

  it("project スコープが効く", async () => {
    const b = await listCodexContentsForBaseline(PROJECT_B);
    expect(b.map((r) => r.id)).toEqual(["m10-bob"]);
  });
});
