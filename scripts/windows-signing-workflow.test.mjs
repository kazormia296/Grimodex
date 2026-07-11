import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");

describe("Windows Electron release signing", () => {
  it("requires certificate secrets and verifies both executable signatures", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    const commands = workflow.jobs.build.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const environments = workflow.jobs.build.steps
      .map((step) => step.env ?? {})
      .map((env) => JSON.stringify(env))
      .join("\n");

    assert.match(environments, /secrets\.WINDOWS_CERTIFICATE/);
    assert.match(environments, /secrets\.WINDOWS_CERTIFICATE_PASSWORD/);
    assert.match(commands, /CSC_LINK/);
    assert.match(commands, /CSC_KEY_PASSWORD/);
    assert.match(commands, /Get-AuthenticodeSignature/);
    assert.match(commands, /win-unpacked/);
    assert.match(commands, /Status.*Valid/);
  });

  it("compiles and exercises the fail-closed Tauri v1 migration bridge", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    const commands = workflow.jobs.build.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    const stepNames = workflow.jobs.build.steps
      .map((step) => step.name)
      .filter(Boolean)
      .join("\n");
    const builder = load(
      await readFile(path.join(root, "electron-builder.yml"), "utf8"),
    );
    const migration = await readFile(
      path.join(root, "electron/installer/tauri-v1-migration.nsh"),
      "utf8",
    );
    const migrationE2e = await readFile(
      path.join(root, "scripts/verify-windows-tauri-migration.ps1"),
      "utf8",
    );

    assert.equal(
      builder.nsis.include,
      "electron/installer/tauri-v1-migration.nsh",
    );
    assert.match(migration, /!macro preInit/);
    assert.match(migration, /!macro customInit/);
    assert.match(migration, /!macro customInstall/);
    assert.match(migration, /Software\\miyakey\\Grimodex/);
    assert.match(
      migration,
      /Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Grimodex/,
    );
    assert.match(migration, /GetOptions[^\n]+"\/P"/);
    assert.match(migration, /SetSilent silent/);
    assert.match(migration, /GetOptions[^\n]+"\/R"/);
    assert.match(migration, /\/P \/UPDATE _\?=\$TauriV1Directory/);
    assert.match(migration, /Publisher/);
    assert.match(migration, /"miyakey"/);
    assert.match(migration, /ExecShellAsUser/);
    assert.doesNotMatch(migration, /RMDir\s+\/r(?:\s|$)/);
    assert.doesNotMatch(migration, /(?:APPDATA|LOCALAPPDATA)/i);
    assert.doesNotMatch(migration, /--delete-app-data/i);
    assert.doesNotMatch(migration, /Exec(?:Wait)?[^\n]*\$R4/);

    assert.match(commands, /electron-builder --publish never/);
    assert.match(stepNames, /Tauri v1 to Electron migration/);
    assert.match(commands, /Get-AuthenticodeSignature/);
    assert.match(migrationE2e, /Grimodex_1\.0\.0_x64-setup\.exe/);
    assert.match(migrationE2e, /com\.miyakey\.grimodex/);
    assert.match(
      migrationE2e,
      /348A45B9C1FF056C19734CF9A85175A96C0FEB5B0B4BA25AF2A29EB65A24EB9E/,
    );
    assert.match(migrationE2e, /electron-migration-roaming\.sentinel/);
    assert.match(migrationE2e, /electron-migration-local\.sentinel/);
    assert.match(migrationE2e, /Assert-OneElectronRegistration/);
    assert.match(migrationE2e, /Wait-ForElectronRestart/);
    assert.match(migrationE2e, /failedMigration\.ExitCode -ne 0/);
  });
});
