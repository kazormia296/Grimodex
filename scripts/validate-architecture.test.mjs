import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectFindings,
  compareArchitectureBaseline,
  createArchitectureBaseline,
  createGenericSqlWriteManifest,
  findNewFindings,
  findNewGenericSqlWriteFindings,
  resolveImport,
} from "./validate-architecture.mjs";

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

test("architecture baseline permits SCC splitting but rejects new SCC members and edges", () => {
  const baseline = {
    schemaVersion: 2,
    findings: {},
    "feature-cycle": {
      sccs: [
        {
          members: ["a.ts", "b.ts", "c.ts"],
          edges: [
            { from: "a.ts", to: "b.ts" },
            { from: "b.ts", to: "a.ts" },
            { from: "a.ts", to: "c.ts" },
            { from: "c.ts", to: "a.ts" },
          ],
        },
      ],
    },
    metrics: {
      "cross-feature-store-import": 0,
      "cross-feature-store-mutation": 0,
      "dynamic-store-import": 0,
      "cyclic-modules": 3,
      "largest-scc": 3,
      "scc-internal-edges": 4,
    },
    waivers: [],
  };

  const split = {
    findings: {},
    featureCycles: [
      {
        members: ["a.ts", "b.ts"],
        edges: [
          { from: "a.ts", to: "b.ts" },
          { from: "b.ts", to: "a.ts" },
        ],
      },
    ],
    metrics: {
      "cross-feature-store-import": 0,
      "cross-feature-store-mutation": 0,
      "dynamic-store-import": 0,
      "cyclic-modules": 2,
      "largest-scc": 2,
      "scc-internal-edges": 2,
    },
  };

  const splitResult = compareArchitectureBaseline(split, baseline, {
    now: "2026-07-30",
  });
  assert.deepEqual(splitResult.introduced, []);
  assert.ok(
    splitResult.improvements.some((finding) =>
      finding.startsWith("feature-cycle:scc-shrunk:"),
    ),
  );

  const merged = {
    ...split,
    featureCycles: [
      {
        members: ["a.ts", "b.ts", "c.ts", "d.ts"],
        edges: [],
      },
    ],
    metrics: {
      ...split.metrics,
      "cyclic-modules": 4,
      "largest-scc": 4,
    },
  };
  const mergedResult = compareArchitectureBaseline(merged, baseline, {
    now: "2026-07-30",
  });
  assert.ok(
    mergedResult.introduced.some((finding) =>
      finding.startsWith("feature-cycle:new-scc:"),
    ),
  );
  assert.deepEqual(mergedResult.metricIncreases, [
    { baseline: 3, current: 4, metric: "cyclic-modules" },
    { baseline: 3, current: 4, metric: "largest-scc" },
  ]);

  const newEdge = {
    ...split,
    featureCycles: [
      {
        members: ["a.ts", "b.ts", "c.ts"],
        edges: [
          { from: "a.ts", to: "b.ts" },
          { from: "b.ts", to: "a.ts" },
          { from: "a.ts", to: "c.ts" },
          { from: "c.ts", to: "a.ts" },
          { from: "b.ts", to: "c.ts" },
        ],
      },
    ],
    metrics: {
      ...split.metrics,
      "cyclic-modules": 3,
      "largest-scc": 3,
      "scc-internal-edges": 5,
    },
  };
  const edgeResult = compareArchitectureBaseline(newEdge, baseline, {
    now: "2026-07-30",
  });
  assert.ok(
    edgeResult.introduced.some((finding) =>
      finding.startsWith("feature-cycle:new-internal-edge:b.ts->c.ts"),
    ),
  );
  assert.deepEqual(edgeResult.metricIncreases, [
    { baseline: 4, current: 5, metric: "scc-internal-edges" },
  ]);
});

test("architecture baseline tracks ordinary improvements, stale waivers, and expiry", () => {
  const baseline = {
    schemaVersion: 2,
    findings: {
      "cross-feature-store-import": ["old-import", "removed-import"],
    },
    "feature-cycle": { sccs: [] },
    metrics: {
      "cross-feature-store-import": 2,
      "cross-feature-store-mutation": 0,
      "dynamic-store-import": 0,
      "cyclic-modules": 0,
      "largest-scc": 0,
      "scc-internal-edges": 0,
    },
    waivers: [
      {
        id: "expired",
        rule: "cross-feature-store-import",
        signature: "expired-import",
        reason: "temporary migration",
        ownerArea: "architecture",
        issue: 123,
        introducedAt: "2026-01-01",
        expiresAt: "2026-07-29",
      },
      {
        id: "stale",
        rule: "cross-feature-store-import",
        signature: "stale-import",
        reason: "temporary migration",
        ownerArea: "architecture",
        issue: 124,
        introducedAt: "2026-01-01",
        expiresAt: "2026-12-31",
      },
    ],
  };
  const current = {
    findings: {
      "cross-feature-store-import": ["old-import", "expired-import"],
    },
    featureCycles: [],
    metrics: {
      "cross-feature-store-import": 2,
      "cross-feature-store-mutation": 0,
      "dynamic-store-import": 0,
      "cyclic-modules": 0,
      "largest-scc": 0,
      "scc-internal-edges": 0,
    },
  };

  const result = compareArchitectureBaseline(current, baseline, {
    now: "2026-07-30",
  });

  assert.deepEqual(result.introduced, [
    "cross-feature-store-import:expired-import",
  ]);
  assert.deepEqual(result.improvements, [
    "cross-feature-store-import:removed-import#baseline-1-observed-0",
  ]);
  assert.deepEqual(
    result.expiredWaivers.map((waiver) => waiver.id),
    ["expired"],
  );
  assert.deepEqual(
    result.staleWaivers.map((waiver) => waiver.id),
    ["stale"],
  );
});

test("architecture baseline writer stores SCC members and metrics instead of canonical cycle strings", () => {
  const baseline = createArchitectureBaseline({
    findings: {
      "cross-feature-store-import": ["known-import"],
      "feature-cycle": ["a.ts -> b.ts"],
      "generic-renderer-sql-write": ["not-in-architecture-baseline"],
    },
    featureCycles: [
      {
        members: ["a.ts", "b.ts"],
        edges: [{ from: "a.ts", to: "b.ts" }],
      },
    ],
    metrics: {
      "cross-feature-store-import": 1,
      "cross-feature-store-mutation": 0,
      "dynamic-store-import": 0,
      "cyclic-modules": 2,
      "largest-scc": 2,
      "scc-internal-edges": 1,
    },
  });

  assert.equal(baseline.schemaVersion, 2);
  assert.deepEqual(baseline.findings["cross-feature-store-import"], [
    "known-import",
  ]);
  assert.deepEqual(baseline["feature-cycle"].sccs, [
    {
      members: ["a.ts", "b.ts"],
      edges: [{ from: "a.ts", to: "b.ts" }],
    },
  ]);
  assert.equal(baseline.findings["generic-renderer-sql-write"], undefined);
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

test("generic renderer SQL write rule inventories Drizzle, raw SQL, and direct generic routes", async () => {
  const fixture = await fixtureRepo();
  await writeSource(fixture.root, "src/db/client.ts", "export const db = {};");
  await writeSource(
    fixture.root,
    "src/lib/tauri.ts",
    "export async function invoke() {}",
  );
  await writeSource(
    fixture.root,
    "src/features/example/api.ts",
    [
      'import { db as rendererDb } from "@/db/client";',
      'import { invoke as callNative } from "@/lib/tauri";',
      "export async function mutate(rows: unknown[]) {",
      "  await rendererDb.insert(items).values(rows);",
      "  await rendererDb.insert(items).values(rows);",
      "  await rendererDb.update(items).set({ active: true });",
      "  await rendererDb.delete(oldItems);",
      '  await callNative("db_execute_batch", { statements: rows });',
      '  await callNative("db_execute", {',
      "    sql: `DELETE FROM audit_log WHERE created_at < ?`,",
      "    params: [0],",
      '    method: "run",',
      "  });",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/read.ts",
    [
      'import { db } from "@/db/client";',
      "export const read = () => db.select().from(items);",
    ].join("\n"),
  );

  const findings = await collectFindings({
    repoRoot: fixture.root,
    sourceRoot: fixture.source,
  });

  assert.deepEqual(findings["generic-renderer-sql-write"], [
    "src/features/example/api.ts:drizzle-delete:oldItems#1",
    "src/features/example/api.ts:drizzle-insert:items#1",
    "src/features/example/api.ts:drizzle-insert:items#2",
    "src/features/example/api.ts:drizzle-update:items#1",
    "src/features/example/api.ts:generic-db-route:db_execute#1",
    "src/features/example/api.ts:generic-db-route:db_execute_batch#1",
    "src/features/example/api.ts:raw-sql-delete:audit_log#1",
  ]);
});

test("generic renderer SQL write baseline rejects an additional same-table callsite", () => {
  const baseline = createGenericSqlWriteManifest([
    "src/features/example/api.ts:drizzle-insert:items#1",
  ]);
  const findings = [
    "src/features/example/api.ts:drizzle-insert:items#1",
    "src/features/example/api.ts:drizzle-insert:items#2",
  ];

  assert.deepEqual(findNewGenericSqlWriteFindings(findings, baseline), [
    "src/features/example/api.ts:drizzle-insert:items#2",
  ]);
});

test("generic renderer SQL write baseline must shrink when a callsite is removed", () => {
  const baseline = createGenericSqlWriteManifest([
    "src/features/example/api.ts:drizzle-insert:items#1",
    "src/features/example/api.ts:drizzle-insert:items#2",
  ]);
  const findings = ["src/features/example/api.ts:drizzle-insert:items#1"];

  assert.deepEqual(findNewGenericSqlWriteFindings(findings, baseline), [
    "src/features/example/api.ts:drizzle-insert:items#manifest-2-observed-1",
  ]);
});

test("typed IPC boundary rejects feature-level legacy marker text matching", async () => {
  const fixture = await fixtureRepo();
  await writeSource(
    fixture.root,
    "src/features/example/bad.ts",
    [
      'const WORKSPACE_SWITCHING_MARKER = "WORKSPACE_SWITCHING";',
      "export function bad(error: string) {",
      "  return error.includes(WORKSPACE_SWITCHING_MARKER);",
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/features/example/good.ts",
    [
      "export function good(error: { code?: string }) {",
      '  return error.code === "WORKSPACE_SWITCHING";',
      "}",
    ].join("\n"),
  );
  await writeSource(
    fixture.root,
    "src/lib/tauri.ts",
    [
      "export function classify(message: string) {",
      '  return message.includes("WORKSPACE_SWITCHING");',
      "}",
    ].join("\n"),
  );

  const findings = await collectFindings({
    repoRoot: fixture.root,
    sourceRoot: fixture.source,
  });

  assert.deepEqual(findings["legacy-ipc-error-text-check"], [
    "src/features/example/bad.ts:3:includes:WORKSPACE_SWITCHING",
  ]);
});

test("the general baseline comparator remains independent from the SQL debt manifest", () => {
  assert.deepEqual(
    findNewFindings(
      { "feature-cycle": ["new-cycle"] },
      { "feature-cycle": [] },
    ),
    ["feature-cycle:new-cycle"],
  );
});

test("the local frontend gate includes architecture validation", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts["verify:frontend"], /validate:architecture/);
});
