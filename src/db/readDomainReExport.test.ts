/**
 * MP-4b PR-3b-1：`src/db/schema.ts`・`src/lib/time.ts`・`src/lib/temporal.ts` は
 * `electron/shared/readDomain/` へ移し、旧 path は 1 行の `export * from` にした。
 * importer（旧 path の `@/db/schema` など）が壊れないことを、実行時の同一性と
 * file の形で固定する。型は `tsc`（root と electron の NodeNext）が見る。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as schemaViaStub from "@/db/schema";
import * as temporalViaStub from "@/lib/temporal";
import * as timeViaStub from "@/lib/time";
import * as schemaReal from "@/../electron/shared/readDomain/db/schema";
import * as temporalReal from "@/../electron/shared/readDomain/lib/temporal";
import * as timeReal from "@/../electron/shared/readDomain/lib/time";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MOVED = [
  {
    name: "schema",
    stub: "src/db/schema.ts",
    real: "electron/shared/readDomain/db/schema.ts",
    viaStub: schemaViaStub as Record<string, unknown>,
    actual: schemaReal as Record<string, unknown>,
  },
  {
    name: "time",
    stub: "src/lib/time.ts",
    real: "electron/shared/readDomain/lib/time.ts",
    viaStub: timeViaStub as Record<string, unknown>,
    actual: timeReal as Record<string, unknown>,
  },
  {
    name: "temporal",
    stub: "src/lib/temporal.ts",
    real: "electron/shared/readDomain/lib/temporal.ts",
    viaStub: temporalViaStub as Record<string, unknown>,
    actual: temporalReal as Record<string, unknown>,
  },
] as const;

describe.each(MOVED)("$name の旧 path は実体の re-export", (moved) => {
  it("旧 path は 1 行の `export * from` だけ", () => {
    const text = readFileSync(resolve(REPO_ROOT, moved.stub), "utf8");
    const target = moved.real.replace(/\.ts$/, "");
    // 旧 path の文字列そのものを固定する（import 解決の走査に拾われない作り方で組む）。
    const specifier = ["@", "..", target].join("/");
    expect(text).toBe(`export * from ${JSON.stringify(specifier)};\n`);
  });

  it("旧 path 越しの export は実体と同じ名前・同じ値（同一 instance）", () => {
    const names = Object.keys(moved.actual).sort();
    expect(names.length).toBeGreaterThan(0);
    expect(Object.keys(moved.viaStub).sort()).toEqual(names);
    for (const name of names) {
      expect(moved.viaStub[name]).toBe(moved.actual[name]);
    }
  });

  it("default export を持たない（`export *` は default を運ばない）", () => {
    expect("default" in moved.actual).toBe(false);
  });

  it("実体は `@/` を使わず、相対 import は NodeNext 向けに `.js` 付き", () => {
    const text = readFileSync(resolve(REPO_ROOT, moved.real), "utf8");
    expect(text).not.toMatch(/from\s+["']@\//);
    for (const match of text.matchAll(/from\s+["'](\.{1,2}\/[^"']*)["']/g)) {
      expect(match[1], `${moved.real}: ${match[0]}`).toMatch(/\.js$/);
    }
  });
});
