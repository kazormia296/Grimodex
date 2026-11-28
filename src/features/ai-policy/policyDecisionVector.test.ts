import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getAiPolicyClassification } from "./parse";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "policyDecisionVector.v2.fixture.json",
);

interface FixtureCase {
  label: string;
  raw: string | null;
  state: "valid" | "missing" | "invalid";
  expected: {
    chat: boolean;
    bodyWrite: boolean;
    analysis: boolean;
    structureWrite: boolean;
    knowledgeWrite: boolean;
  };
}

describe("policyDecisionVector v2 (TS parity)", () => {
  const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as FixtureCase[];

  for (const c of cases) {
    it(c.label, () => {
      expect(getAiPolicyClassification(c.raw)).toEqual({
        state: c.state,
        preset:
          c.state === "valid" ? JSON.parse(c.raw as string).preset : "custom",
        toggles: c.expected,
      });
    });
  }
});
