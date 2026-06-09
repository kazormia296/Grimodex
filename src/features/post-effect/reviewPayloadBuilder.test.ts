import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  buildReviewPayload,
  REVIEW_PROMPT_VERSION,
} from "./reviewPayloadBuilder";

const SCENE_ID = "scene-review-payload-test";

async function seedScene(content: string) {
  const now = new Date().toISOString();
  await db.delete(treeNodes).where(eq(treeNodes.id, SCENE_ID));
  await db.insert(treeNodes).values({
    id: SCENE_ID,
    projectId: "default-project",
    nodeType: "scene",
    title: "Review payload test",
    sortOrder: "a0",
    content,
    createdAt: now,
    updatedAt: now,
  });
}

describe("buildReviewPayload", () => {
  beforeEach(async () => {
    await seedScene(
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "本文テスト" }],
          },
        ],
      }),
    );
  });

  it("storyContext 省略 = 空 ctx = 空白のみ ctx で同一ハッシュ (既存キャッシュ不変)", async () => {
    const a = await buildReviewPayload(SCENE_ID, "m", "");
    const b = await buildReviewPayload(SCENE_ID, "m", "", {});
    const c = await buildReviewPayload(SCENE_ID, "m", "", {
      synopsis: "  ",
      outline: " ",
    });
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.inputHash).toBe(c.inputHash);
  });

  it("synopsis を渡すと hash が変化し、内容変更で再変化する", async () => {
    const empty = await buildReviewPayload(SCENE_ID, "m", "");
    const one = await buildReviewPayload(SCENE_ID, "m", "", {
      synopsis: "狙いA",
    });
    const two = await buildReviewPayload(SCENE_ID, "m", "", {
      synopsis: "狙いB",
    });
    expect(one.inputHash).not.toBe(empty.inputHash);
    expect(two.inputHash).not.toBe(one.inputHash);
  });

  it("outline を渡すと hash が変化する", async () => {
    const empty = await buildReviewPayload(SCENE_ID, "m", "");
    const withOutline = await buildReviewPayload(SCENE_ID, "m", "", {
      outline: "第1章",
    });
    expect(withOutline.inputHash).not.toBe(empty.inputHash);
  });

  it("synopsis と outline の取り違えが起きない (別ハッシュ)", async () => {
    const syn = await buildReviewPayload(SCENE_ID, "m", "", { synopsis: "X" });
    const out = await buildReviewPayload(SCENE_ID, "m", "", { outline: "X" });
    expect(syn.inputHash).not.toBe(out.inputHash);
  });

  it("custom と storyContext は独立に hash へ効く", async () => {
    const base = await buildReviewPayload(SCENE_ID, "m", "", { synopsis: "S" });
    const withCustom = await buildReviewPayload(SCENE_ID, "m", "追加指示", {
      synopsis: "S",
    });
    expect(withCustom.inputHash).not.toBe(base.inputHash);
  });

  it("sceneText を返し prompt version は review_v1.0", async () => {
    const { sceneText, inputHash } = await buildReviewPayload(
      SCENE_ID,
      "m",
      "",
    );
    expect(sceneText).toContain("本文テスト");
    expect(REVIEW_PROMPT_VERSION).toBe("review_v1.0");
    expect(inputHash.length).toBeGreaterThan(0);
  });
});
