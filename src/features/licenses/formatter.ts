import type { LicenseEntry } from "./types";

function formatEntry(entry: LicenseEntry): string[] {
  const lines: string[] = [];
  lines.push(`### ${entry.name} (${entry.version})`);
  lines.push("");
  lines.push(`- License: ${entry.license}`);
  if (entry.repository) {
    lines.push(`- Repository: ${entry.repository}`);
  }
  lines.push("");
  if (entry.licenseText) {
    lines.push("<details>");
    lines.push("<summary>License Text</summary>");
    lines.push("");
    lines.push("```");
    lines.push(entry.licenseText);
    lines.push("```");
    lines.push("</details>");
    lines.push("");
  }
  return lines;
}

function formatSection(heading: string, entries: LicenseEntry[]): string[] {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [`## ${heading}`, ""];
  for (const entry of sorted) {
    lines.push(...formatEntry(entry));
  }
  return lines;
}

/**
 * npm/cargo/アセット/参考実装のライセンスエントリ一覧からMarkdown文字列を生成する。
 *
 * Reference Implementations セクションは「コードを直接コピーはしていないが、
 * API プロトコル仕様や設計判断を参考にしたプロジェクト」の明示的な attribution。
 * 厳密には MIT 等の attribution 義務外だが、礼儀および出典追跡のために掲載する。
 */
export function formatLicensesMarkdown(
  npmEntries: LicenseEntry[],
  cargoEntries: LicenseEntry[],
  assetEntries: LicenseEntry[] = [],
  referenceEntries: LicenseEntry[] = [],
): string {
  const lines: string[] = [
    "# Third-Party Licenses",
    "",
    "This file lists the licenses of third-party libraries used by Grimodex.",
    "",
  ];

  lines.push(...formatSection("npm Packages", npmEntries));
  lines.push(...formatSection("Rust Crates", cargoEntries));
  lines.push(...formatSection("Assets", assetEntries));
  lines.push(...formatSection("Reference Implementations", referenceEntries));

  return lines.join("\n");
}
