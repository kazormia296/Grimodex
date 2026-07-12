import { describe, expect, it } from "vitest";
import { EN_CHAT_SYSTEM } from "../en/chatSystem";
import { JA_CHAT_SYSTEM } from "../ja/chatSystem";
import {
  AUTHOR_POLICY_TAG,
  PROMPT_DATA_TAGS,
  PROMPT_DATA_TAG_NAMES,
  PROMPT_RESERVED_TAG_NAMES,
} from "./dataLayerRegistry";

describe("prompt data-layer registry", () => {
  it("has unique data and reserved boundary tags", () => {
    expect(new Set(PROMPT_DATA_TAG_NAMES).size).toBe(
      PROMPT_DATA_TAG_NAMES.length,
    );
    expect(new Set(PROMPT_RESERVED_TAG_NAMES).size).toBe(
      PROMPT_RESERVED_TAG_NAMES.length,
    );
    expect(PROMPT_RESERVED_TAG_NAMES).toContain(AUTHOR_POLICY_TAG);
    expect(new Set(Object.values(PROMPT_DATA_TAGS))).toEqual(
      new Set(PROMPT_DATA_TAG_NAMES),
    );
  });

  it.each([
    ["ja", JA_CHAT_SYSTEM.baseText],
    ["en", EN_CHAT_SYSTEM.baseText],
  ])(
    "names every reserved tag without rendering wrapper tokens in the %s base prompt",
    (_lang, text) => {
      for (const tag of PROMPT_RESERVED_TAG_NAMES) {
        expect(text, tag).toContain(`\`${tag}\``);
        expect(text, tag).not.toContain(`<${tag}>`);
        expect(text, tag).not.toContain(`</${tag}>`);
      }
    },
  );
});
