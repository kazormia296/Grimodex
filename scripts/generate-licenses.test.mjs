import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { tsImport } from "tsx/esm/api";

const root = path.resolve(import.meta.dirname, "..");
const generator = await tsImport("./generate-licenses.ts", import.meta.url);

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

  it("keeps generated copies byte-identical and includes N-API runtime crates", async () => {
    const [rootLicenses, publicLicenses] = await Promise.all([
      readFile(path.join(root, "THIRD_PARTY_LICENSES.md")),
      readFile(path.join(root, "public/THIRD_PARTY_LICENSES.md")),
    ]);

    assert.deepEqual(publicLicenses, rootLicenses);
    const markdown = rootLicenses.toString("utf8");
    for (const crate of ["napi", "napi-build", "napi-derive", "napi-sys"]) {
      const headings = markdown.match(
        new RegExp(`^### ${crate.replace("-", "\\-")} \\(`, "gm"),
      );
      assert.equal(headings?.length, 1, crate);
    }
  });
});
