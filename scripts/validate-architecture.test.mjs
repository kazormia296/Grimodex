import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectFindings, resolveImport } from "./validate-architecture.mjs";

async function fixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-architecture-"));
  const source = path.join(root, "src");
  await mkdir(source, { recursive: true });
  return { root, source };
}

async function writeSource(root, relative, source) {
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, source);
  return absolute;
}

test("application component rule resolves extensionless imports", async () => {
  const fixture = await fixtureRepo();
  await writeSource(
    fixture.root,
    "src/application/useCase.ts",
    [
      'import { Widget } from "@/features/widget/Widget";',
      'import type { Model } from "@/features/widget/model.ts";',
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/widget/Widget.tsx",
    "export function Widget() { return null; }",
  );
  await writeSource(
    fixture.root,
    "src/features/widget/model.ts",
    "export interface Model { id: string }",
  );

  const findings = await collectFindings({
    repoRoot: fixture.root,
    sourceRoot: fixture.source,
  });

  assert.deepEqual(findings["application-component-import"], [
    "src/application/useCase.ts:@/features/widget/Widget",
  ]);
});

test("cycle graph includes relative imports and index.tsx targets", async () => {
  const fixture = await fixtureRepo();
  const alphaStore = await writeSource(
    fixture.root,
    "src/features/alpha/store.ts",
    'import "./bridge";',
  );
  await writeSource(
    fixture.root,
    "src/features/alpha/bridge.ts",
    'import "@/features/beta";',
  );
  await writeSource(
    fixture.root,
    "src/features/beta/index.tsx",
    'import "@/features/alpha/store";',
  );

  assert.equal(
    resolveImport(alphaStore, "./bridge", fixture.source),
    path.join(fixture.source, "features/alpha/bridge.ts"),
  );
  assert.equal(
    resolveImport(alphaStore, "@/features/beta", fixture.source),
    path.join(fixture.source, "features/beta/index.tsx"),
  );

  const findings = await collectFindings({
    repoRoot: fixture.root,
    sourceRoot: fixture.source,
  });
  assert.deepEqual(findings["feature-cycle"], [
    [
      "src/features/alpha/bridge.ts",
      "src/features/alpha/store.ts",
      "src/features/beta/index.tsx",
    ].join(" -> "),
  ]);
});

test("the local frontend gate includes architecture validation", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts["verify:frontend"], /validate:architecture/);
});
