import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeTransactionSteps } from "./transactionLogSummary";

describe("summarizeTransactionSteps", () => {
  it("returns positions and character counts without retaining inserted text", () => {
    const secretSentinel = "SECRET_NOVEL_SENTINEL";
    class ReplaceStep {
      from = 12;
      to = 18;
      slice = {
        content: {
          size: secretSentinel.length,
          textBetween: () => secretSentinel,
        },
      };
    }

    const summary = summarizeTransactionSteps([new ReplaceStep()]);

    expect(summary).toEqual([
      {
        stepType: "replace",
        from: 12,
        to: 18,
        insertedChars: secretSentinel.length,
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain(secretSentinel);
  });

  it("uses content size for atomic/custom content without readable text", () => {
    class ReplaceAroundStep {
      from = 3;
      to = 7;
      slice = { content: { size: 2 } };
    }

    expect(summarizeTransactionSteps([new ReplaceAroundStep()])).toEqual([
      {
        stepType: "replaceAround",
        from: 3,
        to: 7,
        insertedChars: 2,
      },
    ]);
  });
});

describe("editor logging architecture", () => {
  it("does not serialize raw transaction steps in editor surfaces", () => {
    const files = ["EditorPane.tsx", "LinearSceneBlock.tsx"];
    for (const file of files) {
      const source = readFileSync(resolve(__dirname, file), "utf8");
      expect(source).not.toMatch(
        /transaction\.steps[\s\S]{0,120}(?:toJSON|JSON\.stringify)/,
      );
      expect(source).not.toMatch(
        /JSON\.stringify[\s\S]{0,120}transaction\.steps/,
      );
    }
  });

  it("does not send editor transaction failures to raw console sinks", () => {
    const source = readFileSync(
      resolve(__dirname, "sceneEditorTransactionPipeline.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/console\.(?:warn|error|info|debug)\s*\(/);
  });
});
