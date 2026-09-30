import type { GenericImportResourceRole } from "./resourceRole";

export interface RoleRuleMatch {
  readonly ruleId: string;
  readonly role: GenericImportResourceRole;
  readonly priority: number;
}

export interface RoleRuleInput {
  readonly relativePath: string;
  readonly extension?: string;
  readonly tableHeaders?: readonly string[];
}

/** Safe glob-like prefix rules — no regex. Supports any-parent and folder prefixes. */
export const DEFAULT_ROLE_RULES: readonly {
  readonly id: string;
  readonly pattern: string;
  readonly role: GenericImportResourceRole;
  readonly priority: number;
}[] = [
  {
    id: "manuscript-dir",
    pattern: "**/manuscript/",
    role: "manuscript",
    priority: 10,
  },
  {
    id: "chapters-dir",
    pattern: "chapters/",
    role: "manuscript",
    priority: 20,
  },
  {
    id: "characters-dir",
    pattern: "**/characters/",
    role: "character-reference",
    priority: 10,
  },
  {
    id: "codex-dir",
    pattern: "**/codex/",
    role: "character-reference",
    priority: 20,
  },
  {
    id: "world-dir",
    pattern: "**/world/",
    role: "world-reference",
    priority: 10,
  },
  {
    id: "glossary-dir",
    pattern: "**/glossary/",
    role: "glossary",
    priority: 10,
  },
  {
    id: "timeline-dir",
    pattern: "**/timeline/",
    role: "timeline-reference",
    priority: 10,
  },
  { id: "plot-dir", pattern: "**/plot/", role: "plot-reference", priority: 10 },
  {
    id: "snippets-dir",
    pattern: "**/snippets/",
    role: "snippet-library",
    priority: 10,
  },
  {
    id: "research-dir",
    pattern: "**/research/",
    role: "research-reference",
    priority: 10,
  },
  { id: "assets-dir", pattern: "assets/", role: "attachment", priority: 40 },
  { id: "ignore-dot", pattern: "**/.", role: "ignore", priority: 100 },
];

export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\/+/u, "");
}

export function matchesRolePattern(
  relativePath: string,
  pattern: string,
): boolean {
  const normalizedPath =
    normalizeRelativePath(relativePath).toLocaleLowerCase("en-US");
  const normalizedPattern = pattern.toLocaleLowerCase("en-US");

  if (normalizedPattern.startsWith("**/")) {
    const suffix = normalizedPattern.slice(3);
    return (
      normalizedPath.includes(`/${suffix}`) || normalizedPath.startsWith(suffix)
    );
  }

  return normalizedPath.startsWith(normalizedPattern);
}

export function matchRoleRules(input: RoleRuleInput): readonly RoleRuleMatch[] {
  const extension = input.extension?.toLocaleLowerCase("en-US");
  const matches: RoleRuleMatch[] = [];

  for (const rule of DEFAULT_ROLE_RULES) {
    if (matchesRolePattern(input.relativePath, rule.pattern)) {
      matches.push({
        ruleId: rule.id,
        role: rule.role,
        priority: rule.priority,
      });
    }
  }

  if (extension === "csv" || extension === "tsv") {
    const headers = (input.tableHeaders ?? []).map((h) =>
      h.toLocaleLowerCase("en-US"),
    );
    if (
      headers.includes("name") &&
      (headers.includes("aliases") ||
        headers.includes("role") ||
        headers.includes("type"))
    ) {
      matches.push({
        ruleId: "header-character-table",
        role: "character-reference",
        priority: 5,
      });
    }
    if (headers.includes("term") && headers.includes("definition")) {
      matches.push({
        ruleId: "header-glossary-table",
        role: "glossary",
        priority: 5,
      });
    }
    if (headers.includes("title") && headers.includes("content")) {
      matches.push({
        ruleId: "header-snippet-table",
        role: "snippet-library",
        priority: 5,
      });
    }
  }

  if (
    extension === "md" ||
    extension === "markdown" ||
    extension === "txt" ||
    extension === "text"
  ) {
    matches.push({
      ruleId: "extension-manuscript",
      role: "manuscript",
      priority: 50,
    });
  }

  return matches.sort((a, b) => a.priority - b.priority);
}
