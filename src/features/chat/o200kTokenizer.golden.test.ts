/**
 * These golden counts were sampled from the renderer's actual
 * contextBuilder.ensureTokenizer() + countTokens() implementation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import golden from "./__fixtures__/o200kTokenizer.golden.json";
import {
  countTokens,
  ensureTokenizer,
  getTokenEstimatorFamily,
} from "./contextBuilder";

interface GoldenCase {
  readonly name: string;
  readonly text: string;
  readonly repeat?: number;
  readonly count?: number;
  readonly error?: string;
}

const cases = golden.cases as GoldenCase[];

beforeAll(async () => {
  const wasmPath = fileURLToPath(
    new URL(
      "../../../node_modules/tiktoken/lite/tiktoken_bg.wasm",
      import.meta.url,
    ),
  );
  const wasmBytes = readFileSync(wasmPath);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(new Uint8Array(wasmBytes), {
          headers: { "Content-Type": "application/wasm" },
        }),
    ),
  );
  await ensureTokenizer();
  expect(getTokenEstimatorFamily()).toBe("o200k_base");
});

afterAll(() => vi.unstubAllGlobals());

describe("renderer o200k_base tokenizer golden", () => {
  it.each(cases)(
    "matches the renderer count for $name",
    ({ text, repeat, count, error }) => {
      const input = text.repeat(repeat ?? 1);
      if (error) {
        expect(() => countTokens(input)).toThrow(error);
      } else {
        expect(countTokens(input)).toBe(count);
      }
    },
  );
});
