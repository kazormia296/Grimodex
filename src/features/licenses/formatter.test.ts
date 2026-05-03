import { describe, it, expect } from "vitest";
import { formatLicensesMarkdown } from "./formatter";
import type { LicenseEntry } from "./types";

describe("formatLicensesMarkdown", () => {
  it("ヘッダーとプロジェクト名を含む", () => {
    const result = formatLicensesMarkdown([], []);
    expect(result).toContain("# Third-Party Licenses");
    expect(result).toContain("Grimodex");
  });

  it("npmパッケージセクションを出力する", () => {
    const npm: LicenseEntry[] = [
      { name: "react", version: "19.1.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).toContain("## npm Packages");
    expect(result).toContain("react");
    expect(result).toContain("19.1.0");
    expect(result).toContain("MIT");
  });

  it("Rust cratesセクションを出力する", () => {
    const cargo: LicenseEntry[] = [
      { name: "serde", version: "1.0.0", license: "MIT OR Apache-2.0" },
    ];
    const result = formatLicensesMarkdown([], cargo);
    expect(result).toContain("## Rust Crates");
    expect(result).toContain("serde");
    expect(result).toContain("1.0.0");
    expect(result).toContain("MIT OR Apache-2.0");
  });

  it("Assetsセクションを出力する", () => {
    const assets: LicenseEntry[] = [
      {
        name: "Cork001",
        version: "1K-JPG",
        license: "CC0-1.0",
        repository: "https://ambientcg.com/view?id=Cork001",
      },
    ];
    const result = formatLicensesMarkdown([], [], assets);
    expect(result).toContain("## Assets");
    expect(result).toContain("Cork001");
    expect(result).toContain("CC0-1.0");
    expect(result).toContain("https://ambientcg.com/view?id=Cork001");
  });

  it("Assetsエントリが空のセクションは出力しない", () => {
    const npm: LicenseEntry[] = [
      { name: "react", version: "19.1.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, [], []);
    expect(result).not.toContain("## Assets");
  });

  it("npm/cargo両方のセクションを出力する", () => {
    const npm: LicenseEntry[] = [
      { name: "react", version: "19.1.0", license: "MIT" },
    ];
    const cargo: LicenseEntry[] = [
      { name: "serde", version: "1.0.0", license: "MIT OR Apache-2.0" },
    ];
    const result = formatLicensesMarkdown(npm, cargo);
    expect(result).toContain("## npm Packages");
    expect(result).toContain("## Rust Crates");
  });

  it("エントリが空のセクションは出力しない", () => {
    const npm: LicenseEntry[] = [
      { name: "react", version: "19.1.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).not.toContain("## Rust Crates");
  });

  it("リポジトリURLを含める", () => {
    const npm: LicenseEntry[] = [
      {
        name: "react",
        version: "19.1.0",
        license: "MIT",
        repository: "https://github.com/facebook/react",
      },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).toContain("https://github.com/facebook/react");
  });

  it("ライセンス本文を含める", () => {
    const npm: LicenseEntry[] = [
      {
        name: "test-pkg",
        version: "1.0.0",
        license: "MIT",
        licenseText: "MIT License\n\nCopyright (c) 2024 Test",
      },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).toContain("MIT License");
    expect(result).toContain("Copyright (c) 2024 Test");
  });

  it("エントリをアルファベット順にソートする", () => {
    const npm: LicenseEntry[] = [
      { name: "zustand", version: "5.0.0", license: "MIT" },
      { name: "react", version: "19.0.0", license: "MIT" },
      { name: "jotai", version: "2.0.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, []);
    const jotaiIdx = result.indexOf("jotai");
    const reactIdx = result.indexOf("react");
    const zustandIdx = result.indexOf("zustand");
    expect(jotaiIdx).toBeLessThan(reactIdx);
    expect(reactIdx).toBeLessThan(zustandIdx);
  });

  it("リポジトリURLが無い場合はRepository行を出力しない", () => {
    const npm: LicenseEntry[] = [
      { name: "test-pkg", version: "1.0.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).not.toContain("Repository");
  });

  it("ライセンス本文が無い場合はdetailsブロックを出力しない", () => {
    const npm: LicenseEntry[] = [
      { name: "test-pkg", version: "1.0.0", license: "MIT" },
    ];
    const result = formatLicensesMarkdown(npm, []);
    expect(result).not.toContain("<details>");
  });

  it("元の配列を変更しない", () => {
    const npm: LicenseEntry[] = [
      { name: "b-pkg", version: "1.0.0", license: "MIT" },
      { name: "a-pkg", version: "1.0.0", license: "MIT" },
    ];
    const original = [...npm];
    formatLicensesMarkdown(npm, []);
    expect(npm).toEqual(original);
  });
});
