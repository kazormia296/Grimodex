import type { LicenseEntry } from "./types";

export interface ParsedLicenses {
  npm: LicenseEntry[];
  cargo: LicenseEntry[];
}

type Section = "npm" | "cargo" | null;

/**
 * formatLicensesMarkdown が生成した Markdown を構造データにパースする。
 *
 * フォーマット:
 *   ## npm Packages
 *   ### <name> (<version>)
 *   - License: <license>
 *   - Repository: <url>       ← 省略可
 *   <details>…```<licenseText>```…</details>  ← 省略可
 */
export function parseLicensesMarkdown(markdown: string): ParsedLicenses {
  const npm: LicenseEntry[] = [];
  const cargo: LicenseEntry[] = [];

  if (!markdown.trim()) return { npm, cargo };

  let currentSection: Section = null;
  let currentEntry: Partial<LicenseEntry> | null = null;
  let inCodeFence = false;
  let inDetails = false;
  let licenseTextLines: string[] = [];

  const lines = markdown.split("\n");

  function pushEntry() {
    if (!currentEntry?.name) return;
    const entry: LicenseEntry = {
      name: currentEntry.name,
      version: currentEntry.version ?? "unknown",
      license: currentEntry.license ?? "UNKNOWN",
      repository: currentEntry.repository,
      licenseText:
        licenseTextLines.length > 0
          ? licenseTextLines.join("\n").trim() || undefined
          : undefined,
    };
    if (currentSection === "npm") npm.push(entry);
    else if (currentSection === "cargo") cargo.push(entry);
    currentEntry = null;
    licenseTextLines = [];
    inDetails = false;
    inCodeFence = false;
  }

  for (const line of lines) {
    // Section headers
    if (line.startsWith("## npm")) {
      pushEntry();
      currentSection = "npm";
      continue;
    }
    if (line.startsWith("## Rust")) {
      pushEntry();
      currentSection = "cargo";
      continue;
    }
    // Skip other ## headers (e.g. inside license texts that start with ##)
    if (line.startsWith("## ") && !inCodeFence) {
      continue;
    }

    // Entry headers: ### name (version)
    if (line.startsWith("### ") && !inCodeFence) {
      pushEntry();
      const header = line.slice(4).trim();
      const m = header.match(/^(.+?)\s+\((.+?)\)$/);
      if (m) {
        currentEntry = { name: m[1], version: m[2] };
      } else {
        currentEntry = { name: header };
      }
      continue;
    }

    if (!currentEntry) continue;

    // License / Repository metadata lines
    if (line.startsWith("- License: ") && !inCodeFence) {
      currentEntry.license = line.slice("- License: ".length).trim();
      continue;
    }
    if (line.startsWith("- Repository: ") && !inCodeFence) {
      currentEntry.repository = line.slice("- Repository: ".length).trim();
      continue;
    }

    // <details> / </details>
    if (line.trim() === "<details>" && !inCodeFence) {
      inDetails = true;
      continue;
    }
    if (line.trim() === "</details>" && !inCodeFence) {
      inDetails = false;
      continue;
    }

    if (!inDetails) continue;

    // Code fence toggle inside <details>
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }

    if (inCodeFence) {
      licenseTextLines.push(line);
    }
  }

  pushEntry();
  return { npm, cargo };
}
