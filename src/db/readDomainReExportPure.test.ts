/**
 * MP-4b PR-3b-2：PR-3b-1 の 3 本に続き、残りの pure module 21 本を `electron/shared/readDomain/` へ移し、
 * 旧 path は 1 行の `export * from` にした。importer（旧 path の import）が壊れないことを、
 * file の形と実行時の同一性で固定する（`readDomainReExport.test.ts` の続き。3 本はそちらが担当）。
 * 型だけの module（tree/types、foreshadow/types）は実行時の export が 0 で、名前の一致（空）だけを見る。
 * 型は `tsc`（root と electron の NodeNext）が見る。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MOVED = [
  {
    path: "lib/fts",
    stub: () => import("@/lib/fts"),
    real: () => import("@/../electron/shared/readDomain/lib/fts"),
  },
  {
    path: "lib/prosemirror",
    stub: () => import("@/lib/prosemirror"),
    real: () => import("@/../electron/shared/readDomain/lib/prosemirror"),
  },
  {
    path: "lib/createResultMetadata",
    stub: () => import("@/lib/createResultMetadata"),
    real: () =>
      import("@/../electron/shared/readDomain/lib/createResultMetadata"),
  },
  {
    path: "lib/nativeMutationMetadata",
    stub: () => import("@/lib/nativeMutationMetadata"),
    real: () =>
      import("@/../electron/shared/readDomain/lib/nativeMutationMetadata"),
  },
  {
    path: "features/tree/fractionalIndex",
    stub: () => import("@/features/tree/fractionalIndex"),
    real: () =>
      import("@/../electron/shared/readDomain/features/tree/fractionalIndex"),
  },
  {
    path: "features/tree/treeReadingOrder",
    stub: () => import("@/features/tree/treeReadingOrder"),
    real: () =>
      import("@/../electron/shared/readDomain/features/tree/treeReadingOrder"),
  },
  {
    path: "features/tree/types",
    stub: () => import("@/features/tree/types"),
    real: () => import("@/../electron/shared/readDomain/features/tree/types"),
  },
  {
    path: "features/chronicle/chronicleSecrecy",
    stub: () => import("@/features/chronicle/chronicleSecrecy"),
    real: () =>
      import("@/../electron/shared/readDomain/features/chronicle/chronicleSecrecy"),
  },
  {
    path: "features/chronicle/chronicleSnapshot",
    stub: () => import("@/features/chronicle/chronicleSnapshot"),
    real: () =>
      import("@/../electron/shared/readDomain/features/chronicle/chronicleSnapshot"),
  },
  {
    path: "features/chronicle/chronicleTime",
    stub: () => import("@/features/chronicle/chronicleTime"),
    real: () =>
      import("@/../electron/shared/readDomain/features/chronicle/chronicleTime"),
  },
  {
    path: "features/chronicle/chronicleReform",
    stub: () => import("@/features/chronicle/chronicleReform"),
    real: () =>
      import("@/../electron/shared/readDomain/features/chronicle/chronicleReform"),
  },
  {
    path: "features/chronicle/resolveSceneAnchor",
    stub: () => import("@/features/chronicle/resolveSceneAnchor"),
    real: () =>
      import("@/../electron/shared/readDomain/features/chronicle/resolveSceneAnchor"),
  },
  {
    path: "features/codex/context/codexVisibilityPolicy",
    stub: () => import("@/features/codex/context/codexVisibilityPolicy"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/context/codexVisibilityPolicy"),
  },
  {
    path: "features/codex/context/resolvedCodexContext",
    stub: () => import("@/features/codex/context/resolvedCodexContext"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/context/resolvedCodexContext"),
  },
  {
    path: "features/codex/context/resolveApplicablePhases",
    stub: () => import("@/features/codex/context/resolveApplicablePhases"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/context/resolveApplicablePhases"),
  },
  {
    path: "features/codex/context/sceneTimeIndex",
    stub: () => import("@/features/codex/context/sceneTimeIndex"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/context/sceneTimeIndex"),
  },
  {
    path: "features/codex/phaseResolver",
    stub: () => import("@/features/codex/phaseResolver"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/phaseResolver"),
  },
  {
    path: "features/codex/prosemirrorTextExtractor",
    stub: () => import("@/features/codex/prosemirrorTextExtractor"),
    real: () =>
      import("@/../electron/shared/readDomain/features/codex/prosemirrorTextExtractor"),
  },
  {
    path: "features/foreshadow/deriveLabel",
    stub: () => import("@/features/foreshadow/deriveLabel"),
    real: () =>
      import("@/../electron/shared/readDomain/features/foreshadow/deriveLabel"),
  },
  {
    path: "features/foreshadow/normalizeForeshadowRow",
    stub: () => import("@/features/foreshadow/normalizeForeshadowRow"),
    real: () =>
      import("@/../electron/shared/readDomain/features/foreshadow/normalizeForeshadowRow"),
  },
  {
    path: "features/foreshadow/types",
    stub: () => import("@/features/foreshadow/types"),
    real: () =>
      import("@/../electron/shared/readDomain/features/foreshadow/types"),
  },
] as const;

describe("MP-4b PR-3b-2 で移した module は 21 本", () => {
  it("一覧は 21 本で重複しない", () => {
    expect(MOVED).toHaveLength(21);
    expect(new Set(MOVED.map((m) => m.path)).size).toBe(21);
  });
});

describe.each(MOVED)("$path の旧 path は実体の re-export", (moved) => {
  const stubFile = `src/${moved.path}.ts`;
  const realFile = `electron/shared/readDomain/${moved.path}.ts`;

  it("旧 path は 1 行の `export * from` だけ", () => {
    const text = readFileSync(resolve(REPO_ROOT, stubFile), "utf8");
    // 旧 path の文字列そのものを固定する（import 解決の走査に拾われない作り方で組む）。
    const specifier = ["@", "..", realFile.replace(/\.ts$/, "")].join("/");
    expect(text).toBe(`export * from ${JSON.stringify(specifier)};\n`);
  });

  it("旧 path 越しの export は実体と同じ名前・同じ値（同一 instance）", async () => {
    const viaStub = (await moved.stub()) as Record<string, unknown>;
    const actual = (await moved.real()) as Record<string, unknown>;
    const names = Object.keys(actual).sort();
    expect(Object.keys(viaStub).sort()).toEqual(names);
    for (const name of names) {
      expect(viaStub[name]).toBe(actual[name]);
    }
    // `export *` は default を運ばない。default export があると importer の形が変わる。
    expect("default" in actual).toBe(false);
  });

  it("実体は `@/` を使わず、相対 import は NodeNext 向けに `.js` 付き", () => {
    const text = readFileSync(resolve(REPO_ROOT, realFile), "utf8");
    expect(text).not.toMatch(/from\s+["']@\//);
    for (const match of text.matchAll(/from\s+["'](\.{1,2}\/[^"']*)["']/g)) {
      expect(match[1], `${realFile}: ${match[0]}`).toMatch(/\.js$/);
    }
  });
});
