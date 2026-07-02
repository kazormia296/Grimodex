import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, snippets } from "@/db/schema";
import { updateSnippet } from "./api";
import { SnippetVersionConflictError } from "./occ";

// updateSnippet の OCC (baseVersion) を browser-mock の実 SQLite で検証する。
// codex の occUpdate.test.ts と対になるが、こちらは mock ではなく実 DB で
// 「条件付き UPDATE の WHERE version=? が本当に効く」ことまで担保する。

const PROJECT = "snippet-occ-project";

async function versionOf(id: string): Promise<number | undefined> {
  const rows = await db
    .select({ version: snippets.version })
    .from(snippets)
    .where(eq(snippets.id, id));
  return rows[0]?.version;
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await db
    .insert(projects)
    .values({ id: PROJECT, title: PROJECT, createdAt: now, updatedAt: now });
  await db.insert(snippets).values([
    { id: "sn-occ", projectId: PROJECT, title: "occ", content: "{}" },
    { id: "sn-blind", projectId: PROJECT, title: "blind", content: "{}" },
  ]);
});

describe("updateSnippet OCC (base_version)", () => {
  it("baseVersion 一致 → 更新成功し、version はインクリメントされる", async () => {
    const r = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v1" },
      { baseVersion: 0 },
    );
    expect(r?.content).toBe("v1");
    expect(r?.version).toBe(1);
    await expect(versionOf("sn-occ")).resolves.toBe(1);
  });

  it("baseVersion 不一致かつ行は存在 → SnippetVersionConflictError (非破壊)", async () => {
    // 直前のテストで version は 1 に進んでいる。古い base (0) での保存は衝突。
    await expect(
      updateSnippet(
        PROJECT,
        "sn-occ",
        { content: "stale" },
        { baseVersion: 0 },
      ),
    ).rejects.toBeInstanceOf(SnippetVersionConflictError);
    // 本文は上書きされていない
    const rows = await db
      .select({ content: snippets.content })
      .from(snippets)
      .where(eq(snippets.id, "sn-occ"));
    expect(rows[0]?.content).toBe("v1");
  });

  it("行が存在しない (別プロジェクト等のスコープ miss) → undefined (従来通り)", async () => {
    const r = await updateSnippet(
      "other-project",
      "sn-occ",
      { content: "x" },
      { baseVersion: 1 },
    );
    expect(r).toBeUndefined();
  });

  it("baseVersion 省略 → blind UPDATE (version 非加算・後方互換)", async () => {
    const r = await updateSnippet(PROJECT, "sn-blind", { content: "b1" });
    expect(r?.content).toBe("b1");
    expect(r?.version).toBe(0);
    await expect(versionOf("sn-blind")).resolves.toBe(0);
  });

  it("連続保存は返り値の version を base に引き継げば自己衝突しない", async () => {
    const first = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v2" },
      { baseVersion: 1 },
    );
    expect(first?.version).toBe(2);
    const second = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v3" },
      { baseVersion: first!.version },
    );
    expect(second?.version).toBe(3);
  });
});
