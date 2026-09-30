import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, snippets } from "@/db/schema";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { createSnippet, updateSnippet } from "./api";
import { SnippetVersionConflictError } from "./occ";

// updateSnippet の OCC (baseVersion) を browser-mock の実 SQLite で検証する。
// codex の occUpdate.test.ts と対になるが、こちらは mock ではなく実 DB で
// typed Native writer の「条件付き UPDATE + fresh generation」が本当に効く
// ことまで担保する。

const PROJECT = "snippet-occ-project";

async function versionOf(id: string): Promise<number | undefined> {
  const rows = await db
    .select({ version: snippets.version })
    .from(snippets)
    .where(eq(snippets.id, id));
  return rows[0]?.version;
}

beforeAll(async () => {
  publishCurrentProjectId(PROJECT);
  const now = new Date().toISOString();
  await db
    .insert(projects)
    .values({ id: PROJECT, title: PROJECT, createdAt: now, updatedAt: now });
  await createSnippet({
    id: "sn-occ",
    projectId: PROJECT,
    title: "occ",
    content: "{}",
  });
  await createSnippet({
    id: "sn-auto-occ",
    projectId: PROJECT,
    title: "auto-occ",
    content: "{}",
  });
});

afterAll(() => {
  publishCurrentProjectId(null);
});

describe("updateSnippet OCC (base_version)", () => {
  it("baseVersion 一致 → 更新成功し、version はインクリメントされる", async () => {
    const r = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v1" },
      { baseVersion: 1 },
    );
    expect(r?.content).toBe("v1");
    expect(r?.version).toBe(2);
    await expect(versionOf("sn-occ")).resolves.toBe(2);
  });

  it("baseVersion 不一致かつ行は存在 → SnippetVersionConflictError (非破壊)", async () => {
    // 直前のテストで version は 2 に進んでいる。古い base (1) での保存は衝突。
    await expect(
      updateSnippet(
        PROJECT,
        "sn-occ",
        { content: "stale" },
        { baseVersion: 1 },
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
    // The writer is now fenced by the current Project authority before it
    // checks the scoped row. Bind that authority to the requested scope so
    // this assertion still exercises the missing-row behavior.
    publishCurrentProjectId("other-project");
    const r = await updateSnippet(
      "other-project",
      "sn-occ",
      { content: "x" },
      { baseVersion: 2 },
    );
    publishCurrentProjectId(PROJECT);
    expect(r).toBeUndefined();
  });

  it("baseVersion 省略 → Native境界直前にfresh rowを読みOCC更新する", async () => {
    const r = await updateSnippet(PROJECT, "sn-auto-occ", { content: "b1" });
    expect(r?.content).toBe("b1");
    expect(r?.version).toBe(2);
    await expect(versionOf("sn-auto-occ")).resolves.toBe(2);
  });

  it("連続保存は返り値の version を base に引き継げば自己衝突しない", async () => {
    const first = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v2" },
      { baseVersion: 2 },
    );
    expect(first?.version).toBe(3);
    const second = await updateSnippet(
      PROJECT,
      "sn-occ",
      { content: "v3" },
      { baseVersion: first!.version },
    );
    expect(second?.version).toBe(4);
  });
});
