/**
 * サードパーティライセンス一覧 (THIRD_PARTY_LICENSES.md) を生成するスクリプト。
 *
 * Usage: npx tsx scripts/generate-licenses.ts
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { formatLicensesMarkdown } from "../src/features/licenses/formatter";
import type { LicenseEntry } from "../src/features/licenses/types";

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

/* ------------------------------------------------------------------ */
/*  npm 依存のライセンス収集                                            */
/* ------------------------------------------------------------------ */

function findLicenseFile(pkgDir: string): string | undefined {
  try {
    const files = readdirSync(pkgDir);
    const licenseFile = files.find((f) => /^licen[cs]e/i.test(f));
    if (licenseFile) {
      return readFileSync(join(pkgDir, licenseFile), "utf-8");
    }
  } catch {
    // directory not readable
  }
  return undefined;
}

function normalizeRepository(repo: unknown): string | undefined {
  if (!repo) return undefined;
  if (typeof repo === "string") return repo;
  if (typeof repo === "object" && repo !== null && "url" in repo) {
    const url = (repo as { url: string }).url;
    return url
      .replace(/^git\+/, "")
      .replace(/\.git$/, "")
      .replace(/^ssh:\/\/git@github\.com/, "https://github.com");
  }
  return undefined;
}

function gatherNpmLicenses(): LicenseEntry[] {
  const pkgJsonPath = join(ROOT, "package.json");
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const depNames = Object.keys(pkgJson.dependencies ?? {});

  const entries: LicenseEntry[] = [];
  for (const name of depNames) {
    // Handle scoped packages: @scope/pkg → node_modules/@scope/pkg
    const pkgDir = join(ROOT, "node_modules", ...name.split("/"));
    const depPkgPath = join(pkgDir, "package.json");
    if (!existsSync(depPkgPath)) continue;

    const depPkg = JSON.parse(readFileSync(depPkgPath, "utf-8"));
    entries.push({
      name,
      version: depPkg.version ?? "unknown",
      license: depPkg.license ?? "UNKNOWN",
      repository: normalizeRepository(depPkg.repository),
      licenseText: findLicenseFile(pkgDir),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Cargo 依存のライセンス収集                                          */
/* ------------------------------------------------------------------ */

interface CargoMetadataPackage {
  name: string;
  version: string;
  license: string | null;
  repository: string | null;
  manifest_path: string;
}

function gatherCargoLicenses(): LicenseEntry[] {
  const cargoDir = join(ROOT, "src-tauri");
  if (!existsSync(join(cargoDir, "Cargo.toml"))) {
    console.warn(
      "Warning: src-tauri/Cargo.toml not found, skipping Cargo licenses",
    );
    return [];
  }

  let metadataJson: string;
  try {
    metadataJson = execSync(
      "cargo metadata --format-version 1 --no-deps 2>/dev/null || cargo metadata --format-version 1",
      { cwd: cargoDir, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    console.warn("Warning: cargo metadata failed, skipping Cargo licenses");
    return [];
  }

  const metadata = JSON.parse(metadataJson);
  const rootPkgName = "grimodex";
  const packages: CargoMetadataPackage[] = metadata.packages ?? [];

  // --no-deps only returns workspace packages. If we got only the root,
  // re-run without --no-deps to get all dependencies.
  let allPackages = packages;
  if (packages.length <= 1) {
    try {
      const fullJson = execSync("cargo metadata --format-version 1", {
        cwd: cargoDir,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      allPackages = JSON.parse(fullJson).packages ?? [];
    } catch {
      console.warn("Warning: cargo metadata (full) failed");
    }
  }

  const entries: LicenseEntry[] = [];
  for (const pkg of allPackages) {
    if (pkg.name === rootPkgName) continue;

    const manifestDir = dirname(pkg.manifest_path);
    entries.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      repository: pkg.repository ?? undefined,
      licenseText: findLicenseFile(manifestDir),
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  メイン                                                             */
/* ------------------------------------------------------------------ */

function main() {
  console.log("Gathering npm licenses...");
  const npmEntries = gatherNpmLicenses();
  console.log(`  Found ${npmEntries.length} npm packages`);

  console.log("Gathering Cargo licenses...");
  const cargoEntries = gatherCargoLicenses();
  console.log(`  Found ${cargoEntries.length} Cargo crates`);

  const markdown = formatLicensesMarkdown(npmEntries, cargoEntries);

  const rootOutput = join(ROOT, "THIRD_PARTY_LICENSES.md");
  writeFileSync(rootOutput, markdown, "utf-8");
  console.log(`Written: ${rootOutput}`);

  const publicOutput = join(ROOT, "public", "THIRD_PARTY_LICENSES.md");
  if (existsSync(join(ROOT, "public"))) {
    writeFileSync(publicOutput, markdown, "utf-8");
    console.log(`Written: ${publicOutput}`);
  }

  console.log("Done!");
}

main();
