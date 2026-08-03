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
    assert.match(pkgbuild, /'alsa-lib'/);
    assert.match(pkgbuild, /makedepends=\('patchelf'\)/);
    assert.match(pkgbuild, /\/usr\/bin\/grimodex/);
    assert.match(pkgbuild, /grimodex-launcher/);
    assert.match(pkgbuild, /grimodex-ime-identity/);
    assert.match(pkgbuild, /patchelf --add-needed/);
    assert.match(pkgbuild, /Exec=\/usr\/bin\/grimodex %U/);
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

    const launcher = await readFile(
      path.join(root, "packaging/arch/grimodex-launcher"),
      "utf8",
    );
    const identitySource = await readFile(
      path.join(root, "packaging/arch/grimodex-ime-identity.c"),
      "utf8",
    );
    assert.match(launcher, /--ozone-platform=x11/);
    assert.match(launcher, /exec \/opt\/Grimodex\/grimodex-bin/);
    assert.match(identitySource, /const char \*g_get_prgname\(void\)/);
    assert.match(identitySource, /return "grimodex"/);
  });

  it("documents the package-manager-only migration path for existing Tauri Arch users", async () => {
    const readme = await readFile(
      path.join(root, "packaging/arch/README.md"),
      "utf8",
    );
    assert.match(readme, /最終公開 Tauri v0\.10\.4/);
    assert.match(readme, /updater 設定がなく/);
    assert.match(readme, /pacman \/ AUR/);
  });

  it("adds the stable Electron Arch artifact before the single publish job", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    assert.ok(workflow.jobs["build-arch"]);
    assert.match(workflow.jobs["build-arch"].if, /should_publish == 'true'/);
    assert.match(workflow.jobs["build-arch"].if, /build\.result == 'success'/);
    assert.deepEqual(workflow.jobs.publish.needs, [
      "release-gate",
      "release-state",
      "ci",
      "bridge-signing-preflight",
      "build",
      "build-arch",
    ]);
    const commands = workflow.jobs["build-arch"].steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(commands, /libgrimodex-ime-identity\.so/);
    assert.match(commands, /g_get_prgname/);
    assert.match(commands, /--ozone-platform=x11/);
    assert.match(commands, /Shared library: \[libgrimodex-ime-identity\.so\]/);
    assert.match(commands, /Exec=\/usr\/bin\/grimodex %U/);
    assert.match(commands, /grimodex-package-channel/);
    assert.match(commands, /chrome-sandbox/);
  });
});
