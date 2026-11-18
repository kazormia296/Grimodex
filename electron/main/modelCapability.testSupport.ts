/**
 * モデル能力の registry の試験で共有する道具（PR-C2）。実際のネットワークには出ない。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MODEL_CAPABILITY_FETCH_URL } from "./modelCapabilityFetch.js";

export const TEST_NOW = Date.parse("2026-11-19T12:00:00Z");
export const BUNDLED_GENERATED_AT = "2026-11-18T00:00:00Z";
export const NEWER_GENERATED_AT = "2026-11-19T00:00:00Z";

/** `<provider>/model-<n>` の model を count 件作る（検証を通る形）。 */
export function makeModels(
  count: number,
  provider = "openai",
  offset = 0,
): Record<string, Record<string, unknown>> {
  const models: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < count; i += 1) {
    models[`${provider}/model-${offset + i}`] = {
      contextWindow: 100_000 + i,
      maxOutputTokens: 8_192,
      toolCall: true,
      reasoning: i % 2 === 0,
    };
  }
  return models;
}

export function snapshotText(
  models: Record<string, unknown>,
  generatedAt: string,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt,
    source: "grimodex",
    models,
    ...overrides,
  });
}

/** 試験ごとの一時 directory。afterEach で `cleanup()` する。 */
export function makeTempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-capability-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function writeBundled(dir: string, text: string): string {
  const file = path.join(dir, "bundled-model-capabilities.json");
  writeFileSync(file, text, "utf8");
  return file;
}

/** `Response` の `url` は構築時に空なので、定数の URL を載せる。 */
export function makeResponse(
  body: ConstructorParameters<typeof Response>[0],
  init: {
    status?: number;
    url?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: init.headers,
  });
  Object.defineProperty(response, "url", {
    value: init.url ?? MODEL_CAPABILITY_FETCH_URL,
  });
  return response;
}
