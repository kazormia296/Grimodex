import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  buildIntentDriftPayload,
  INTENT_DRIFT_PROMPT_VERSION,
} from "./intentDriftPayloadBuilder";

const SCENE_ID = "scene-intent-drift-test";

async function seedScene(content: string) {
  const now = new Date().toISOString();
  await db.delete(treeNodes).where(eq(treeNodes.id, SCENE_ID));
  await db.insert(treeNodes).values({
    id: SCENE_ID,
    projectId: "default-project",
    nodeType: "scene",
    title: "Intent drift test",
    sortOrder: "a0",
    content,
    createdAt: now,
    updatedAt: now,
  });
}

describe("buildIntentDriftPayload", () => {
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

  it("空 intent では scope に intent サフィックスを含まない", async () => {
    const a = await buildIntentDriftPayload(SCENE_ID, "gpt-4o-mini", "");
    const b = await buildIntentDriftPayload(SCENE_ID, "gpt-4o-mini", "   ");
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.inputHash).not.toContain("|intent:");
  });

  it("非空 intent で hash が変化し intent 変更でも再変化する", async () => {
    const empty = await buildIntentDriftPayload(SCENE_ID, "m", "");
    const one = await buildIntentDriftPayload(SCENE_ID, "m", "狙いA");
    const two = await buildIntentDriftPayload(SCENE_ID, "m", "狙いB");
    expect(one.inputHash).not.toBe(empty.inputHash);
    expect(two.inputHash).not.toBe(one.inputHash);
  });

  it("custom 変更でも hash が変化する", async () => {
    const base = await buildIntentDriftPayload(SCENE_ID, "m", "狙い", "");
    const withCustom = await buildIntentDriftPayload(
      SCENE_ID,
      "m",
      "狙い",
      "追加指示",
    );
    expect(withCustom.inputHash).not.toBe(base.inputHash);
  });

  it("prompt version は intent_drift_v1.0", async () => {
    const { inputHash } = await buildIntentDriftPayload(
      SCENE_ID,
      "gpt-4o-mini",
      "狙い",
    );
    expect(INTENT_DRIFT_PROMPT_VERSION).toBe("intent_drift_v1.1");
    expect(inputHash.length).toBeGreaterThan(0);
  });
});
