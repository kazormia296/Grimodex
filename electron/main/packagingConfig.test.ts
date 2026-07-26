import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface PackageJson {
  desktopName?: string;
  homepage?: string;
  main?: string;
  productName?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BuilderConfig {
  appId?: string;
  beforeBuild?: string;
  productName?: string;
  directories?: Record<string, string>;
  files?: string[];
  asarUnpack?: string[];
  extraResources?: Array<{
    from: string;
    to: string;
    filter: string[];
  }>;
  win?: Record<string, unknown>;
  nsis?: Record<string, unknown>;
  mac?: Record<string, unknown>;
  dmg?: Record<string, unknown>;
  linux?: Record<string, unknown>;
  deb?: Record<string, unknown>;
  rpm?: Record<string, unknown>;
  publish?: Record<string, unknown>;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ) as PackageJson;
}

function readBuilderConfig(): BuilderConfig {
  return load(
    readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8"),
  ) as BuilderConfig;
}

describe("Electron release packaging contract", () => {
  it("prepares licensed native artifacts before either builder mode", () => {
    const pkg = readPackageJson();

    expect(pkg.main).toBe("dist-electron/main.cjs");
    expect(pkg.productName).toBe("Grimodex");
    expect(pkg.desktopName).toBe("grimodex");
    expect(pkg.homepage).toBe("https://github.com/kazormia296/Grimodex");
    expect(pkg.dependencies?.["electron-updater"]).toBe("6.8.9");
    expect(pkg.devDependencies?.["electron-builder"]).toBe("26.15.3");
    expect(pkg.scripts?.["napi:build:release"]).toBe(
      "pnpm --dir electron/native/grimodex-node exec napi build --release --features licensing,legacy-keyring-migration",
    );
    expect(pkg.scripts?.["electron:native:release"]).toBe(
      "pnpm napi:build:release && pnpm napi:verify:release && pnpm mcp:build:release",
    );
    expect(pkg.scripts?.["electron:package:dir"]).toBe(
      "pnpm electron:native:release && pnpm electron:build && electron-builder --dir",
    );
    expect(pkg.scripts?.["electron:package"]).toBe(
      "pnpm electron:native:release && pnpm electron:build && electron-builder",
    );
  });

  it("packages only the runtime app files and unpacks the native module", () => {
    const config = readBuilderConfig();

    expect(config).toMatchObject({
      appId: "com.miyakey.grimodex",
      productName: "Grimodex",
      beforeBuild: "./electron/scripts/beforeBuild.mjs",
      directories: {
        output: "release/electron",
        buildResources: "src-tauri/icons",
      },
    });
    expect(config.files).toEqual([
      "dist/**",
      "dist-electron/**",
      "package.json",
      "electron/native/grimodex-node/grimodex-node.node",
    ]);
    expect(config.asarUnpack).toEqual([
      "electron/native/grimodex-node/grimodex-node.node",
    ]);
  });

  it("places the MCP executable and semantic tokenizers at runtime paths", () => {
    const config = readBuilderConfig();

    expect(config.extraResources).toEqual([
      {
        from: "src-tauri/target/release",
        to: "bin",
        filter: ["grimodex-mcp", "grimodex-mcp.exe"],
      },
      {
        from: "src-tauri/resources/semantic",
        to: "resources/semantic",
        filter: ["**/tokenizer.json"],
      },
    ]);
  });

  it("defines every desktop target, stable artifact names, and GitHub publish", () => {
    const config = readBuilderConfig();

    expect(config.win).toEqual({
      target: ["nsis"],
      artifactName: "${productName}-${version}-windows-${arch}.${ext}",
    });
    expect(config.nsis).toEqual({
      include: "electron/installer/tauri-v1-migration.nsh",
    });
    expect(config.mac).toEqual({
      target: ["dmg", "zip"],
      artifactName: "${productName}-${version}-mac-${arch}.${ext}",
      hardenedRuntime: true,
    });
    expect(config.dmg).toEqual({ writeUpdateInfo: false });
    expect(config.linux).toEqual({
      target: ["AppImage", "deb", "rpm"],
      artifactName: "${productName}-${version}-linux-${arch}.${ext}",
      category: "Office",
      syncDesktopName: true,
    });
    expect(config.deb).toEqual({
      packageName: "grimodex",
      depends: [
        "libc6 (>= 2.39)",
        "libstdc++6 (>= 12)",
        "libgcc-s1",
        "libdbus-1-3",
        "libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libxss1",
        "libxtst6",
        "xdg-utils",
        "libatspi2.0-0",
        "libuuid1",
        "libsecret-1-0",
      ],
    });
    expect(config.rpm).toEqual({
      packageName: "grimodex",
      fpm: ["--rpm-posttrans=packaging/linux/rpm-posttrans.sh"],
      depends: [
        "glibc >= 2.39",
        "libstdc++",
        "libgcc",
        "dbus-libs",
        "libsecret",
        "gtk3",
        "libnotify",
        "nss",
        "libXScrnSaver",
        "(libXtst or libXtst6)",
        "xdg-utils",
        "at-spi2-core",
        "(libuuid or libuuid1)",
      ],
    });
    expect(config.publish).toEqual({
      provider: "github",
      owner: "kazormia296",
      repo: "Grimodex",
    });
  });
});
