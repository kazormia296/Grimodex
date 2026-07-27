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

test("scene load rule rejects array loops but permits legitimate single loads", async () => {
  const fixture = await fixtureRepo();
  await writeSource(
    fixture.root,
    "src/features/example/bad-map.ts",
    [
      'import { loadSceneContent as loadBody } from "@/features/tree/api";',
      "export async function loadAll(ids: string[]) {",
      "  return Promise.all(ids.map(async (id) => loadBody(id)));",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/bad-for.ts",
    [
      'import { loadSceneFull } from "@/features/tree/api";',
      "export async function loadAll(ids: string[]) {",
      "  const rows = [];",
      "  for (const id of ids) rows.push(await loadSceneFull(id));",
      "  return rows;",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/nested/bad-relative.ts",
    [
      'import { loadSceneContent } from "../../tree/api";',
      "export async function loadAll(ids: string[]) {",
      "  for (let i = 0; i < ids.length; i++) {",
      "    await loadSceneContent(ids[i]);",
      "  }",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/bad-direct-callback.ts",
    [
      'import { loadSceneContent } from "@/features/tree/api";',
      "export async function loadAll(ids: string[]) {",
      "  return Promise.all(ids.map(loadSceneContent));",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/good.ts",
    [
      'import { loadSceneContent, loadSceneContents } from "@/features/tree/api";',
      "export const loadOne = (id: string) => loadSceneContent(id);",
      "export const loadAll = (ids: string[]) => loadSceneContents(ids);",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/tree/api.ts",
    [
      "export async function loadSceneContent(id: string) { return id; }",
      "export async function loadSceneFull(id: string) { return { id }; }",
      "export async function loadSceneContents(ids: string[]) { return ids; }",
    ].join("\n"),
  );

  const findings = await collectFindings({
    repoRoot: fixture.root,
    sourceRoot: fixture.source,
  });

  assert.deepEqual(findings["single-scene-load-in-array-loop"], [
    "src/features/example/bad-direct-callback.ts:loadSceneContent:map",
    "src/features/example/bad-for.ts:loadSceneFull:for-of",
    "src/features/example/bad-map.ts:loadSceneContent:map",
    "src/features/example/nested/bad-relative.ts:loadSceneContent:for",
  ]);
});

test("the local frontend gate includes architecture validation", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts["verify:frontend"], /validate:architecture/);
});
