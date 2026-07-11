import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");

describe("Arch packaging transition", () => {
  it("uses the Electron deb artifact and drops WebKit runtime dependencies", async () => {
    const pkgbuild = await readFile(
      path.join(root, "packaging/arch/PKGBUILD"),
      "utf8",
    );
    assert.match(pkgbuild, /Electron \+ React/);
    assert.match(pkgbuild, /Grimodex-\$\{pkgver\}-linux-amd64\.deb/);
    assert.doesNotMatch(pkgbuild, /webkit2gtk/);
    assert.match(pkgbuild, /\/usr\/bin\/grimodex/);
    assert.match(pkgbuild, /\/opt\/Grimodex\/grimodex/);
    assert.match(pkgbuild, /grimodex-package-channel/);
    assert.match(pkgbuild, /printf 'arch\\n'/);
    for (const dependency of [
      "gtk3",
      "libnotify",
      "nss",
      "libxss",
      "libxtst",
      "xdg-utils",
      "at-spi2-core",
      "libsecret",
      "dbus",
    ]) {
      assert.match(pkgbuild, new RegExp(`'${dependency}'`));
    }
  });

  it("documents the package-manager-only migration path for existing Tauri Arch users", async () => {
    const readme = await readFile(
      path.join(root, "packaging/arch/README.md"),
      "utf8",
    );
    assert.match(readme, /Tauri v1/);
    assert.match(readme, /dpkg/);
    assert.match(readme, /pacman \/ AUR/);
  });

  it("adds the stable Electron Arch artifact before the single publish job", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    assert.ok(workflow.jobs["build-arch"]);
    assert.equal(
      workflow.jobs["build-arch"].if,
      "needs.release-gate.outputs.prerelease == 'false'",
    );
    assert.deepEqual(workflow.jobs.publish.needs, [
      "release-gate",
      "build",
      "build-arch",
    ]);
    const commands = workflow.jobs["build-arch"].steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(commands, /readlink package-check\/usr\/bin\/grimodex/);
    assert.match(commands, /grimodex-package-channel/);
    assert.match(commands, /chrome-sandbox/);
  });
});
