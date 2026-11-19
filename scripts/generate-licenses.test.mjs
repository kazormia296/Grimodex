import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { tsImport } from "tsx/esm/api";

const root = path.resolve(import.meta.dirname, "..");
const generator = await tsImport("./generate-licenses.ts", import.meta.url);
const formatter = await tsImport(
  "../src/features/licenses/formatter.ts",
  import.meta.url,
);

const cargoPackage = (name, version, id) => ({
  id,
  name,
  version,
  license: "MIT",
  repository: `https://example.com/${name}`,
  manifest_path: `/nonexistent/cargo/${name}-${version}/Cargo.toml`,
});

describe("third-party license generation", () => {
  it("normalizes upstream license text for deterministic clean Markdown", () => {
    assert.equal(
      generator.normalizeLicenseText("first line  \r\nsecond line\t\r\n"),
      "first line\nsecond line\n",
    );
  });

  it("unions both Cargo graphs while excluding all Grimodex workspace members", () => {
    const core = cargoPackage(
      "grimodex-core",
      "0.1.0",
      "path+file:///repo/src-tauri/crates/grimodex-core#0.1.0",
    );
    const node = cargoPackage(
      "grimodex-node",
      "0.1.0",
      "path+file:///repo/electron/native/grimodex-node#0.1.0",
    );
    const serde = cargoPackage(
      "serde",
      "1.0.0",
      "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.0",
    );
    const napiPackages = ["napi", "napi-build", "napi-derive", "napi-sys"].map(
      (name) =>
        cargoPackage(
          name,
          "2.0.0",
          `registry+https://github.com/rust-lang/crates.io-index#${name}@2.0.0`,
        ),
    );

    const entries = generator.buildCargoLicenseEntries([
      {
        packages: [core, serde],
        workspace_members: [core.id],
      },
      {
        packages: [node, core, serde, ...napiPackages],
        workspace_members: [node.id],
      },
    ]);

    assert.deepEqual(
      entries.map(({ name, version }) => `${name}@${version}`),
      [
        "napi@2.0.0",
        "napi-build@2.0.0",
        "napi-derive@2.0.0",
        "napi-sys@2.0.0",
        "serde@1.0.0",
      ],
    );
    assert.deepEqual(generator.CARGO_MANIFEST_RELATIVE_PATHS, [
      "src-tauri/Cargo.toml",
      "electron/native/grimodex-node/Cargo.toml",
    ]);
  });

  it("collects the complete pnpm production graph deterministically", async (t) => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-license-generator-"),
    );
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

    const createPackage = async (
      relativePath,
      { name, version, license = "MIT", repository, licenseFiles = {} },
    ) => {
      const packagePath = path.join(fixtureRoot, relativePath);
      await mkdir(packagePath, { recursive: true });
      await writeFile(
        path.join(packagePath, "package.json"),
        JSON.stringify({ name, version, license, repository }),
      );
      await Promise.all(
        Object.entries(licenseFiles).map(([filename, text]) =>
          writeFile(path.join(packagePath, filename), text),
        ),
      );
      return packagePath;
    };

    const rootRuntime = await createPackage(
      "node_modules/.pnpm/root-runtime@1.0.0/node_modules/root-runtime",
      {
        name: "root-runtime",
        version: "1.0.0",
        repository: "git+https://example.com/root-runtime.git",
        licenseFiles: { LICENSE: "root license\r\n" },
      },
    );
    const transitiveRuntime = await createPackage(
      "node_modules/.pnpm/transitive-runtime@3.0.0/node_modules/transitive-runtime",
      {
        name: "transitive-runtime",
        version: "3.0.0",
        licenseFiles: { LICENSE: "transitive license\n" },
      },
    );
    const workspaceRuntime = await createPackage(
      "node_modules/.pnpm/workspace-runtime-only@4.0.0/node_modules/workspace-runtime-only",
      {
        name: "workspace-runtime-only",
        version: "4.0.0",
        licenseFiles: { LICENSE: "workspace runtime license\n" },
      },
    );
    const sharedV1 = await createPackage(
      "node_modules/.pnpm/shared@1.0.0/node_modules/shared",
      {
        name: "shared",
        version: "1.0.0",
        licenseFiles: { LICENSE: "shared v1 license\n" },
      },
    );
    const sharedV2 = await createPackage(
      "node_modules/.pnpm/shared@2.0.0/node_modules/shared",
      {
        name: "shared",
        version: "2.0.0",
        license: "Apache-2.0 OR MIT",
        licenseFiles: {
          LICENSE_MIT: "MIT license\r\n",
          "LICENSE_APACHE-2.0": "Apache license\n",
        },
      },
    );
    const sharedV2PeerContext = await createPackage(
      "node_modules/.pnpm/shared@2.0.0_peer@1.0.0/node_modules/shared",
      {
        name: "shared",
        version: "2.0.0",
        license: "Apache-2.0 OR MIT",
        licenseFiles: {
          LICENSE_MIT: "MIT license\r\n",
          "LICENSE_APACHE-2.0": "Apache license\n",
        },
      },
    );
    const firstPartyWorkspace = await createPackage("packages/scan-core", {
      name: "@grimodex/scan-core",
      version: "0.1.0",
      license: "UNLICENSED",
    });

    const report = {
      MIT: [
        {
          name: "workspace-runtime-only",
          versions: ["4.0.0"],
          paths: [workspaceRuntime],
        },
        {
          name: "root-runtime",
          versions: ["1.0.0"],
          paths: [rootRuntime],
        },
        {
          name: "transitive-runtime",
          versions: ["3.0.0"],
          paths: [transitiveRuntime],
        },
      ],
      "Apache-2.0 OR MIT": [
        {
          name: "shared",
          versions: ["2.0.0", "1.0.0", "2.0.0"],
          paths: [sharedV2, sharedV1, sharedV2PeerContext],
        },
      ],
      UNLICENSED: [
        {
          name: "@grimodex/scan-core",
          versions: ["0.1.0"],
          paths: [firstPartyWorkspace],
        },
      ],
    };

    let invokedArgs;
    const entries = generator.gatherNpmLicenses(
      (args) => {
        invokedArgs = [...args];
        return JSON.stringify(report);
      },
      { importers: {}, snapshots: {} },
      path.join(fixtureRoot, "node_modules/.pnpm"),
    );

    assert.deepEqual(invokedArgs, ["licenses", "list", "--prod", "--json"]);
    assert.deepEqual(
      entries.map(({ name, version }) => `${name}@${version}`),
      [
        "root-runtime@1.0.0",
        "shared@1.0.0",
        "shared@2.0.0",
        "transitive-runtime@3.0.0",
        "workspace-runtime-only@4.0.0",
      ],
    );
    assert.equal(entries[0].repository, "https://example.com/root-runtime");
    assert.equal(entries[0].licenseText, "root license\n");

    const sharedV2Entry = entries.find(
      ({ name, version }) => name === "shared" && version === "2.0.0",
    );
    assert.equal(sharedV2Entry.license, "Apache-2.0 OR MIT");
    assert.match(sharedV2Entry.licenseText, /Apache license/);
    assert.match(sharedV2Entry.licenseText, /MIT license/);
    assert.ok(
      sharedV2Entry.licenseText.indexOf("Apache license") <
        sharedV2Entry.licenseText.indexOf("MIT license"),
    );

    const reversedReport = Object.fromEntries(
      Object.entries(report)
        .reverse()
        .map(([license, packages]) => [
          license,
          [...packages].reverse().map((pkg) => ({
            ...pkg,
            versions: [...pkg.versions].reverse(),
            paths: [...pkg.paths].reverse(),
          })),
        ]),
    );
    assert.deepEqual(generator.buildNpmLicenseEntries(reversedReport), entries);
    assert.throws(
      () =>
        generator.buildNpmLicenseEntries({
          MIT: [
            {
              name: "broken-runtime",
              versions: ["1.0.0"],
              paths: [],
            },
          ],
        }),
      /Mismatched pnpm license paths for broken-runtime/,
    );
  });

  it("derives the production closure from the lockfile with real package names", () => {
    const closure = generator.collectProductionClosure({
      importers: {
        ".": {
          dependencies: {
            "@scope/app": { specifier: "^1", version: "1.0.0(peer@1.0.0)" },
            "local-pkg": {
              specifier: "workspace:*",
              version: "link:packages/local",
            },
          },
          optionalDependencies: { "opt-native": "2.0.0" },
        },
        "packages/local": { dependencies: { "local-dep": "3.0.0" } },
      },
      snapshots: {
        "@scope/app@1.0.0(peer@1.0.0)": {
          dependencies: {
            "alias-v1": "uuid@11.1.1",
            "alias-v0": "uuid@10.0.0",
            "dev-looking": "shared@1.0.0",
          },
        },
        "shared@1.0.0": {},
        "uuid@11.1.1": {},
        "uuid@10.0.0": {},
        "opt-native@2.0.0": { optional: true },
        "local-dep@3.0.0": {},
        "dev-only@9.0.0": {},
      },
    });
    assert.deepEqual(
      closure.map(({ name, version, optional }) => [name, version, optional]),
      [
        ["@scope/app", "1.0.0", false],
        ["local-dep", "3.0.0", false],
        ["opt-native", "2.0.0", true],
        ["shared", "1.0.0", false],
        ["uuid", "10.0.0", false],
        ["uuid", "11.1.1", false],
      ],
    );
  });

  it("returns the same npm entries however pnpm drops aliased packages", async (t) => {
    const fixtureRoot = await mkdtemp(
      path.join(os.tmpdir(), "grimodex-license-determinism-"),
    );
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const virtualStore = path.join(fixtureRoot, "node_modules/.pnpm");

    const install = async (dir, name, version) => {
      const pkgDir = path.join(virtualStore, dir, "node_modules", name);
      await mkdir(pkgDir, { recursive: true });
      await writeFile(
        path.join(pkgDir, "package.json"),
        JSON.stringify({ name, version, license: "MIT" }),
      );
      await writeFile(path.join(pkgDir, "LICENSE"), `${name} ${version}\n`);
      return pkgDir;
    };
    await install("@a2a-js+sdk@0.3.14", "@a2a-js/sdk", "0.3.14");
    const sdkNew = await install("@a2a-js+sdk@1.0.1", "@a2a-js/sdk", "1.0.1");
    const uuid = await install("uuid@11.1.1", "uuid", "11.1.1");
    const core = await install("core@1.0.0_peer@1.0.0", "core", "1.0.0");
    // opt-native（他 platform 向けの optional 依存）はインストールされていない。

    const lockfile = {
      importers: {
        ".": {
          dependencies: { core: "1.0.0(peer@1.0.0)" },
          devDependencies: { dev: "1.0.0" },
        },
      },
      snapshots: {
        "core@1.0.0(peer@1.0.0)": {
          dependencies: {
            "@a2a-js/sdk-v0_3": "@a2a-js/sdk@0.3.14",
            "@a2a-js/sdk-v1": "@a2a-js/sdk@1.0.1",
          },
          optionalDependencies: { "opt-native": "2.0.0" },
        },
        "@a2a-js/sdk@0.3.14": { dependencies: { uuid: "11.1.1" } },
        "@a2a-js/sdk@1.0.1": { dependencies: { uuid: "11.1.1" } },
        "uuid@11.1.1": {},
        "opt-native@2.0.0": { optional: true },
        "dev@1.0.0": {},
      },
    };

    const full = {
      MIT: [
        { name: "core", versions: ["1.0.0"], paths: [core] },
        { name: "@a2a-js/sdk", versions: ["1.0.1"], paths: [sdkNew] },
        { name: "uuid", versions: ["11.1.1"], paths: [uuid] },
      ],
    };
    const gather = (report) =>
      generator
        .gatherNpmLicenses(() => JSON.stringify(report), lockfile, virtualStore)
        .map(({ name, version, license, licenseText }) => [
          name,
          version,
          license,
          licenseText,
        ]);

    const expected = gather(full);
    assert.deepEqual(
      expected.map(([name, version]) => `${name}@${version}`),
      ["@a2a-js/sdk@0.3.14", "@a2a-js/sdk@1.0.1", "core@1.0.0", "uuid@11.1.1"],
    );
    // 閉包に無い dev 依存と、未インストールの optional 依存は入らない。

    // pnpm が package を 1 つ（または全部）落としても結果は変わらない。
    for (const dropped of ["core", "@a2a-js/sdk", "uuid"]) {
      assert.deepEqual(
        gather({
          MIT: full.MIT.filter((pkg) => pkg.name !== dropped),
        }),
        expected,
        `pnpm omitted ${dropped}`,
      );
    }
    assert.deepEqual(gather({}), expected);

    // 非 optional の閉包 package が未インストールなら、黙って欠落させず止める。
    await rm(path.join(virtualStore, "uuid@11.1.1"), {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => gather({ MIT: full.MIT.filter((pkg) => pkg.name !== "uuid") }),
      /uuid@11\.1\.1 from pnpm-lock\.yaml is not installed/,
    );
  });

  it("uses a cross-platform pnpm invocation", () => {
    assert.deepEqual(
      generator.resolvePnpmInvocation(["licenses", "list"], {
        platform: "win32",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath: "C:\\pnpm\\bin\\pnpm.cjs",
        commandShell: "C:\\Windows\\System32\\cmd.exe",
      }),
      {
        command: "C:\\Program Files\\nodejs\\node.exe",
        args: ["C:\\pnpm\\bin\\pnpm.cjs", "licenses", "list"],
      },
    );
    assert.deepEqual(
      generator.resolvePnpmInvocation(["licenses", "list"], {
        platform: "win32",
        nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
        npmExecPath: undefined,
        commandShell: "C:\\Windows\\System32\\cmd.exe",
      }),
      {
        command: "C:\\Windows\\System32\\cmd.exe",
        args: ["/d", "/s", "/c", "pnpm licenses list"],
      },
    );
  });

  it("ships the complete AMD FidelityFX FSR 1 notice for adapted shaders", async () => {
    const fsr = generator
      .gatherReferenceImplementations()
      .find(({ name }) => name === "AMD FidelityFX Super Resolution 1");

    assert.ok(fsr, "the manually adapted FSR 1 shader must be attributed");
    assert.equal(fsr.license, "MIT");
    assert.equal(
      fsr.repository,
      "https://github.com/GPUOpen-Effects/FidelityFX-FSR",
    );
    assert.match(
      fsr.licenseText,
      /Copyright \(c\) 2021 Advanced Micro Devices/,
    );
    assert.match(
      fsr.licenseText,
      /Permission is hereby granted, free of charge/,
    );
    assert.match(
      fsr.licenseText,
      /included in all\s+copies or substantial portions of the Software/,
    );
    assert.match(fsr.licenseText, /THE SOFTWARE IS PROVIDED "AS IS"/);

    const [rootNotices, publicNotices] = await Promise.all([
      readFile(path.join(root, "THIRD_PARTY_LICENSES.md"), "utf8"),
      readFile(path.join(root, "public/THIRD_PARTY_LICENSES.md"), "utf8"),
    ]);
    assert.equal(publicNotices, rootNotices);
    const fsrNotice = rootNotices.slice(
      rootNotices.indexOf("### AMD FidelityFX Super Resolution 1"),
      rootNotices.indexOf("### react-ide-workspace-layout"),
    );
    assert.match(fsrNotice, /Permission is hereby granted, free of charge/);
    assert.match(fsrNotice, /THE SOFTWARE IS PROVIDED "AS IS"/);
  });

  it("keeps generated copies fresh and byte-identical", async () => {
    const [rootLicenses, publicLicenses] = await Promise.all([
      readFile(path.join(root, "THIRD_PARTY_LICENSES.md")),
      readFile(path.join(root, "public/THIRD_PARTY_LICENSES.md")),
    ]);

    assert.deepEqual(publicLicenses, rootLicenses);
    const markdown = rootLicenses.toString("utf8");
    const npmEntries = generator.gatherNpmLicenses();
    const npmSection = markdown.slice(
      markdown.indexOf("## npm Packages"),
      markdown.indexOf("## Rust Crates"),
    );
    const expectedNpmMarkdown = formatter.formatLicensesMarkdown(
      npmEntries,
      [],
    );
    const expectedNpmSection = expectedNpmMarkdown.slice(
      expectedNpmMarkdown.indexOf("## npm Packages"),
    );
    assert.equal(
      npmSection.trimEnd(),
      expectedNpmSection.trimEnd(),
      "generated npm package metadata and license texts must be fresh",
    );

    const npmNames = new Set(npmEntries.map(({ name }) => name));
    for (const runtimeDependency of ["@ai-sdk/provider", "ajv", "fast-uri"]) {
      assert.ok(npmNames.has(runtimeDependency), runtimeDependency);
    }
    for (const excludedDependency of [
      "@grimodex/scan-contract",
      "@grimodex/scan-core",
      "@grimodex/scan-prompts",
      "@grimodex/scan-web",
      "electron",
      "eslint",
      "vitest",
    ]) {
      assert.ok(!npmNames.has(excludedDependency), excludedDependency);
    }

    for (const crate of ["napi", "napi-build", "napi-derive", "napi-sys"]) {
      const headings = markdown.match(
        new RegExp(`^### ${crate.replace("-", "\\-")} \\(`, "gm"),
      );
      assert.equal(headings?.length, 1, crate);
    }
  });
});
