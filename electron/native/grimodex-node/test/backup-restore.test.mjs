// list_backups / restore_backup の napi 境界契約。
// 実SQLiteファイルで .db / .db.gz、破損・traversal非破壊、安全退避、
// migration非互換候補の適用前拒否を確認する。共有Rust本体の細かい分岐はcrate単体テストが担う。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import initSqlJs from "sql.js/dist/sql-asm.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));
const SQL = await initSqlJs();

function makeFixture(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-backup-${label}-`));
  const appData = join(root, "app-data");
  const workspace = join(root, "workspace");
  const backups = join(workspace, "backups");
  // Keep ordinary backup-list/restore fixtures free of the detached automatic
  // backup writer. Tests that exercise trusted automatic backup creation opt
  // in explicitly in writeBackupViaTrustedOpen below.
  mkdirSync(appData, { recursive: true });
  writeFileSync(
    join(appData, "global-settings.json"),
    JSON.stringify({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "ja",
      uiScale: 100,
      showLauncherOnStartup: false,
      userPreferences: { "data.autoBackup": "false" },
    }),
  );
  const backend = new Backend(appData);
  return {
    root,
    workspace,
    backups,
    backend,
    cleanup: () =>
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50,
      }),
  };
}

async function rows(backend, sql, params = [], method = "all") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

async function waitForNewBackup(backend, before, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const created = JSON.parse(await backend.listBackups()).find(
      ({ fileName }) => !before.has(fileName),
    );
    if (created) return created;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`automatic backup was not created within ${timeoutMs}ms`);
}

async function writeBackupViaTrustedOpen(backend, workspace, path) {
  const before = new Set(
    JSON.parse(await backend.listBackups()).map(({ fileName }) => fileName),
  );
  const settings = JSON.parse(await backend.getGlobalSettings());
  settings.userPreferences = {
    ...(settings.userPreferences ?? {}),
    "data.autoBackup": "true",
    "data.backupInterval": "0",
  };
  await backend.saveGlobalSettings(settings);
  await backend.openWorkspace(workspace);
  const created = await waitForNewBackup(backend, before);
  const compressed = readFileSync(join(workspace, "backups", created.fileName));
  writeFileSync(
    path,
    path.endsWith(".gz") ? compressed : gunzipSync(compressed),
  );
}

async function seedVersion(backend, version) {
  await rows(
    backend,
    "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('backup-test-version', ?)",
    [version],
    "run",
  );
}

async function readVersion(backend) {
  const result = await rows(
    backend,
    "SELECT value FROM app_settings WHERE key = 'backup-test-version'",
    [],
    "get",
  );
  return result[0]?.value;
}

test("workspace未openでは listBackups / restoreBackup が安定マーカーでrejectする", async (t) => {
  const fixture = makeFixture("no-workspace");
  t.after(fixture.cleanup);

  await assert.rejects(fixture.backend.listBackups(), /No workspace is open/);
  await assert.rejects(
    fixture.backend.restoreBackup("grimodex-20260711-120000.db"),
    /No workspace is open/,
  );
});

test("listBackupsはdb/db.gzだけを新しい順でcamelCase DTOにする", async (t) => {
  const fixture = makeFixture("list");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(fixture.workspace);
  rmSync(fixture.backups, { recursive: true, force: true });
  mkdirSync(fixture.backups, { recursive: true });

  const oldDb = join(fixture.backups, "grimodex-20260710-120000.db");
  const newGz = join(fixture.backups, "grimodex-20260711-120000.db.gz");
  writeFileSync(oldDb, "plain");
  writeFileSync(newGz, "gzip");
  writeFileSync(join(fixture.backups, "grimodex-ignored.db.tmp"), "tmp");
  writeFileSync(join(fixture.backups, "other.db"), "other");
  utimesSync(
    oldDb,
    new Date("2026-07-10T12:00:00Z"),
    new Date("2026-07-10T12:00:00Z"),
  );
  utimesSync(
    newGz,
    new Date("2026-07-11T12:00:00Z"),
    new Date("2026-07-11T12:00:00Z"),
  );

  const listed = JSON.parse(await fixture.backend.listBackups());
  assert.deepEqual(
    listed.map(({ fileName, sizeBytes, format }) => ({
      fileName,
      sizeBytes,
      format,
    })),
    [
      {
        fileName: "grimodex-20260711-120000.db.gz",
        sizeBytes: 4,
        format: "db.gz",
      },
      {
        fileName: "grimodex-20260710-120000.db",
        sizeBytes: 5,
        format: "db",
      },
    ],
  );
  assert.ok(listed[0].modifiedMs > listed[1].modifiedMs);
});

test("restoreBackupは.dbをroundtripし復元直前の安全退避を残す", async (t) => {
  const fixture = makeFixture("plain");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(fixture.workspace);
  mkdirSync(fixture.backups, { recursive: true });

  await seedVersion(fixture.backend, "v1");
  const backupName = "grimodex-20260711-120000.db";
  await writeBackupViaTrustedOpen(
    fixture.backend,
    fixture.workspace,
    join(fixture.backups, backupName),
  );
  await seedVersion(fixture.backend, "v2");

  await fixture.backend.codexRebuildMatcher([
    {
      id: "stale-entry",
      name: "旧DB人物",
      entryType: "character",
      aliases: [],
      excludedAliases: [],
    },
  ]);
  assert.equal(
    JSON.parse(await fixture.backend.codexMatchText("旧DB人物", [])).length,
    1,
  );

  await fixture.backend.restoreBackup(backupName);

  assert.equal(await readVersion(fixture.backend), "v1");
  assert.deepEqual(
    JSON.parse(await fixture.backend.codexMatchText("旧DB人物", [])),
    [],
    "restore hook clears the DB-derived matcher",
  );
  const listed = JSON.parse(await fixture.backend.listBackups());
  assert.ok(listed.length >= 2, "元バックアップに加えv2の安全退避を残す");
  assert.equal(
    listed
      .filter(({ fileName }) => fileName !== backupName)
      .some(({ format }) => format === "db.gz"),
    true,
  );
  assert.equal(statSync(join(fixture.workspace, "grimodex.db")).isFile(), true);
  assert.throws(
    () => statSync(join(fixture.workspace, "grimodex.db.restore-tmp")),
    /ENOENT/,
  );
});

test("restoreBackupは.db.gzを展開してroundtripする", async (t) => {
  const fixture = makeFixture("gzip");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(fixture.workspace);
  mkdirSync(fixture.backups, { recursive: true });

  await seedVersion(fixture.backend, "gz-v1");
  const backupName = "grimodex-20260711-120000.db.gz";
  await writeBackupViaTrustedOpen(
    fixture.backend,
    fixture.workspace,
    join(fixture.backups, backupName),
  );
  await seedVersion(fixture.backend, "gz-v2");

  await fixture.backend.restoreBackup(backupName);
  assert.equal(await readVersion(fixture.backend), "gz-v1");
});

test("traversalと破損backupは現行DBを変更しない", async (t) => {
  const fixture = makeFixture("invalid");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(fixture.workspace);
  mkdirSync(fixture.backups, { recursive: true });
  await seedVersion(fixture.backend, "live");

  for (const name of [
    "../grimodex.db",
    "sub/grimodex-x.db",
    "grimodex\\x.db",
    "grimodex-../x.db",
    "evil.db",
  ]) {
    await assert.rejects(
      fixture.backend.restoreBackup(name),
      /不正なバックアップ名/,
    );
    assert.equal(await readVersion(fixture.backend), "live");
  }

  const corrupt = "grimodex-20260711-120000.db";
  writeFileSync(join(fixture.backups, corrupt), "not a sqlite database");
  await assert.rejects(
    fixture.backend.restoreBackup(corrupt),
    /バックアップ|SQLite|database|整合性|破損/i,
  );
  assert.equal(await readVersion(fixture.backend), "live");
  assert.equal(statSync(join(fixture.workspace, "grimodex.db")).isFile(), true);
});

test("migration非互換backupは適用前に拒否して現行DBを維持する", async (t) => {
  const fixture = makeFixture("incompatible");
  t.after(fixture.cleanup);
  await fixture.backend.openWorkspace(fixture.workspace);
  mkdirSync(fixture.backups, { recursive: true });
  await seedVersion(fixture.backend, "live");

  const backupName = "grimodex-20260711-130000.db";
  const incompatible = new SQL.Database();
  incompatible.run("CREATE TABLE projects (x INTEGER)");
  writeFileSync(
    join(fixture.backups, backupName),
    Buffer.from(incompatible.export()),
  );
  incompatible.close();

  await assert.rejects(
    fixture.backend.restoreBackup(backupName),
    /現在のアプリで開けません/,
  );
  assert.equal(await readVersion(fixture.backend), "live");
});
