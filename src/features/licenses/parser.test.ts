import { describe, it, expect } from "vitest";
import { parseLicensesMarkdown } from "./parser";
import { formatLicensesMarkdown } from "./formatter";
import type { LicenseEntry } from "./types";

const NPM_ENTRY: LicenseEntry = {
  name: "react",
  version: "19.1.0",
  license: "MIT",
  repository: "https://github.com/facebook/react",
  licenseText: "MIT License\n\nCopyright (c) Facebook",
};

const CARGO_ENTRY: LicenseEntry = {
  name: "serde",
  version: "1.0.0",
  license: "MIT OR Apache-2.0",
  repository: "https://github.com/serde-rs/serde",
};

describe("parseLicensesMarkdown", () => {
  it("空文字列は空リストを返す", () => {
    const result = parseLicensesMarkdown("");
    expect(result.npm).toEqual([]);
    expect(result.cargo).toEqual([]);
  });

  it("npmエントリをパースできる", () => {
    const md = formatLicensesMarkdown([NPM_ENTRY], []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm).toHaveLength(1);
    expect(result.npm[0].name).toBe("react");
    expect(result.npm[0].version).toBe("19.1.0");
    expect(result.npm[0].license).toBe("MIT");
  });

  it("cargoエントリをパースできる", () => {
    const md = formatLicensesMarkdown([], [CARGO_ENTRY]);
    const result = parseLicensesMarkdown(md);

    expect(result.cargo).toHaveLength(1);
    expect(result.cargo[0].name).toBe("serde");
    expect(result.cargo[0].version).toBe("1.0.0");
    expect(result.cargo[0].license).toBe("MIT OR Apache-2.0");
  });

  it("npm/cargo 両方をそれぞれ正しいセクションに振り分ける", () => {
    const md = formatLicensesMarkdown([NPM_ENTRY], [CARGO_ENTRY]);
    const result = parseLicensesMarkdown(md);

    expect(result.npm).toHaveLength(1);
    expect(result.npm[0].name).toBe("react");
    expect(result.cargo).toHaveLength(1);
    expect(result.cargo[0].name).toBe("serde");
  });

  it("repository をパースできる", () => {
    const md = formatLicensesMarkdown([NPM_ENTRY], []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm[0].repository).toBe("https://github.com/facebook/react");
  });

  it("repository がない場合は undefined になる", () => {
    const entry: LicenseEntry = {
      name: "no-repo",
      version: "1.0.0",
      license: "MIT",
    };
    const md = formatLicensesMarkdown([entry], []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm[0].repository).toBeUndefined();
  });

  it("ライセンス本文をパースできる", () => {
    const md = formatLicensesMarkdown([NPM_ENTRY], []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm[0].licenseText).toContain("MIT License");
    expect(result.npm[0].licenseText).toContain("Copyright (c) Facebook");
  });

  it("ライセンス本文がない場合は undefined になる", () => {
    const md = formatLicensesMarkdown([CARGO_ENTRY], []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm[0].licenseText).toBeUndefined();
  });

  it("複数エントリをすべてパースできる", () => {
    const npmEntries: LicenseEntry[] = [
      { name: "react", version: "19.0.0", license: "MIT" },
      { name: "jotai", version: "2.0.0", license: "MIT" },
      { name: "zustand", version: "5.0.0", license: "MIT" },
    ];
    const md = formatLicensesMarkdown(npmEntries, []);
    const result = parseLicensesMarkdown(md);

    expect(result.npm).toHaveLength(3);
    const names = result.npm.map((e) => e.name);
    expect(names).toContain("react");
    expect(names).toContain("jotai");
    expect(names).toContain("zustand");
  });

  it("formatLicensesMarkdown との往復変換で情報が保持される", () => {
    const npm = [NPM_ENTRY];
    const cargo = [CARGO_ENTRY];
    const md = formatLicensesMarkdown(npm, cargo);
    const result = parseLicensesMarkdown(md);

    expect(result.npm[0]).toMatchObject({
      name: NPM_ENTRY.name,
      version: NPM_ENTRY.version,
      license: NPM_ENTRY.license,
      repository: NPM_ENTRY.repository,
    });
    expect(result.cargo[0]).toMatchObject({
      name: CARGO_ENTRY.name,
      version: CARGO_ENTRY.version,
      license: CARGO_ENTRY.license,
    });
  });
});
