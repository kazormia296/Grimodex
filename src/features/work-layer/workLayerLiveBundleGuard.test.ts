import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function imports(source: string): string[] {
  return Array.from(
    source.matchAll(
      /\b(?:import|export)\s+(?!\s*\()[^;]*?\bfrom\s*["']([^"']+)["']/gs,
    ),
    (match) => match[1]!,
  );
}

function containsReturn(node: ts.Node): boolean {
  if (ts.isReturnStatement(node)) return true;
  return ts.forEachChild(node, (child) => containsReturn(child)) ?? false;
}

/**
 * The conditions that stand between the start of the enclosing component or hook and `node`
 * (nested callbacks such as `lazy(() => import(...))` and effects are looked through): `if (c) { ...node... }`
 * encloses it, and an earlier `if (c) { ...; return; }` in an enclosing block rules out
 * every path that does not satisfy `!c`.
 */
function guardsOf(node: ts.Node): string[] {
  const guards: string[] = [];
  let child: ts.Node = node;
  for (
    let parent = node.parent;
    parent;
    child = parent, parent = parent.parent
  ) {
    if (ts.isIfStatement(parent) && parent.thenStatement === child) {
      guards.push(parent.expression.getText());
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      for (const statement of parent.statements) {
        if (statement === child) break;
        if (
          ts.isIfStatement(statement) &&
          containsReturn(statement.thenStatement)
        ) {
          guards.push(statement.expression.getText());
        }
      }
    }
  }
  return guards;
}

interface DynamicImport {
  readonly specifier: string;
  readonly guards: readonly string[];
}

function dynamicImports(path: string): DynamicImport[] {
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: DynamicImport[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) {
        found.push({ specifier: argument.text, guards: guardsOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const guardedModules = [
  "workLayerLivePort",
  "workLayerLiveReaders",
  "workLayerFixture",
  "CodexStructureReviewHostBody",
];

/** The only places allowed to import a guarded module, and the guards each must sit behind. */
const allowedDynamicImports = [
  {
    file: "features/editor/useWorkLayerLivePort.ts",
    modules: ["workLayerLivePort", "workLayerLiveReaders"],
    requiredGuards: [/\beligible\b/],
  },
  {
    file: "features/work-layer/useWorkLayerPreviewPort.ts",
    modules: ["workLayerFixture"],
    requiredGuards: [/import\.meta\.env\.DEV/, /shouldEnableWorkLayerPreview/],
  },
  {
    file: "features/codex/CodexStructureReviewHost.tsx",
    modules: ["CodexStructureReviewHostBody"],
    requiredGuards: [/isCodexStructureExtractionReviewEnabled/],
  },
  {
    file: "features/work-layer/WorkLayerPrototypePreview.tsx",
    modules: ["workLayerFixture"],
    requiredGuards: [/import\.meta\.env\.DEV/],
  },
] as const;

describe("Work Layer live bundle boundaries", () => {
  const files = sourceFiles(sourceRoot).filter(
    (path) => !/\.(?:test|stories)\.[jt]sx?$/.test(path),
  );

  it("never imports live modules or the fixture statically", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const path of imports(source)) {
        expect(
          guardedModules.some((name) => path.includes(name)),
          `${file} statically imports ${path}`,
        ).toBe(false);
      }
    }
  });

  it("reaches live modules and the fixture only from the allowed dynamic imports", () => {
    const allowedFiles = new Set(
      allowedDynamicImports.map((entry) => resolve(sourceRoot, entry.file)),
    );
    for (const file of files) {
      const guarded = dynamicImports(file).filter((item) =>
        guardedModules.some((name) => item.specifier.includes(name)),
      );
      if (guarded.length === 0) continue;
      expect(
        allowedFiles.has(file),
        `${file} dynamically imports ${guarded.map((item) => item.specifier).join(", ")}`,
      ).toBe(true);
    }
  });

  it.each(allowedDynamicImports)(
    "keeps every dynamic import in $file behind its flag guards",
    ({ file, modules, requiredGuards }) => {
      const found = dynamicImports(resolve(sourceRoot, file)).filter((item) =>
        guardedModules.some((name) => item.specifier.includes(name)),
      );
      // Every guarded module the file is allowed to load is loaded, and nothing else.
      for (const name of modules) {
        expect(
          found.some((item) => item.specifier.includes(name)),
          `${file} no longer imports ${name}`,
        ).toBe(true);
      }
      for (const item of found) {
        expect(
          modules.some((name) => item.specifier.includes(name)),
          `${file} imports ${item.specifier}`,
        ).toBe(true);
        for (const required of requiredGuards) {
          expect(
            item.guards.some((guard) => required.test(guard)),
            `${file}: import("${item.specifier}") is not behind ${required} (guards: ${item.guards.join(" | ") || "none"})`,
          ).toBe(true);
        }
      }
    },
  );

  it("opens the live port only when active, a real project exists, and the fixture is not preferred", () => {
    const liveHook = readFileSync(
      resolve(sourceRoot, "features/editor/useWorkLayerLivePort.ts"),
      "utf8",
    );
    expect(liveHook).toMatch(
      /const eligible = activeWorkLayer && !fixturePreferred && projectId != null;/,
    );
    expect(liveHook).toMatch(
      /import\.meta\.env\.DEV && import\.meta\.env\.VITE_WORK_LAYER_FIXTURE === "true"/,
    );
  });

  it("removes the live hook and the review host from a build that closes the flag (the flag is a build-time constant in the same module)", () => {
    const read = (file: string) =>
      readFileSync(resolve(sourceRoot, file), "utf8");
    const liveHook = read("features/editor/useWorkLayerLivePort.ts");
    // 既定は開く。"false"／"0" で閉じる。`import.meta.env.*` は build が値に置き換える。
    expect(liveHook).toMatch(
      /const LIVE_BUILD =\s*import\.meta\.env\.VITE_WORK_LAYER_LIVE !== "false" &&\s*import\.meta\.env\.VITE_WORK_LAYER_LIVE !== "0";/,
    );
    expect(liveHook).toMatch(
      /useWorkLayerLivePort:[\s\S]*?=\s*LIVE_BUILD\s*\?\s*useLiveWorkLayerPort\s*:\s*useNoLiveWorkLayerPort/,
    );

    const reviewHost = read("features/codex/CodexStructureReviewHost.tsx");
    // 意味は isCodexStructureExtractionReviewEnabled と同じ：既定は開き、false／0 で閉じる。
    expect(reviewHost).toMatch(
      /const REVIEW_BUILD =\s*import\.meta\.env\.VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW !== "false" &&\s*import\.meta\.env\.VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW !== "0";/,
    );
    expect(reviewHost).toMatch(
      /CodexStructureReviewHost: ComponentType = REVIEW_BUILD\s*\?\s*ReviewHost\s*:\s*NoReviewHost/,
    );
  });

  it("keeps feature and IPC imports outside the pure Work Layer folder", () => {
    const workLayerFiles = sourceFiles(
      resolve(sourceRoot, "features/work-layer"),
    ).filter((path) => !/\.(?:test|stories)\.[jt]sx?$/.test(path));
    const forbidden = [
      /features\/codex(?:\/|["'])/,
      /features\/narrative-extraction(?:\/|["'])/,
      /features\/project(?:\/|["'])/,
      /@\/lib\/tauri(?:["'])/,
      /@\/store(?:\/|["'])/,
    ];
    for (const file of workLayerFiles) {
      const source = readFileSync(file, "utf8");
      for (const path of imports(source)) {
        expect(
          forbidden.some((pattern) => pattern.test(path)),
          `${file} imports ${path}`,
        ).toBe(false);
      }
      expect(
        source,
        `${file} accesses the preload bridge directly`,
      ).not.toMatch(/\bwindow\s*\.\s*grimodex\b/);
    }
  });
});
