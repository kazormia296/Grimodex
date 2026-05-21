/**
 * Project-wide Lint scan.
 *
 * Walks all scene nodes for a project, serialises each scene's stored
 * ProseMirror JSON into `WireLintBlock[]`, and invokes the Rust
 * `lint_text` command for each. Results accumulate in the caller-
 * provided callback; a supplied AbortSignal lets the user cancel mid-
 * run while keeping partial results.
 *
 * Unlike the live editor path (`useLinter.ts`), this module doesn't
 * build a ProseMirror offset map — navigation from a Project-mode
 * diagnostic happens *after* the target scene is loaded into the
 * editor, and we rebuild the map there using the live doc.
 */

import { invoke } from "@/lib/tauri";
import { listNodes, loadSceneContent } from "@/features/tree/api";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { listCodexEntries } from "@/features/codex/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import type {
  BlockKind,
  Diagnostic,
  LintCodexEntry,
  LintConfig,
  LintLanguage,
  LintResponse,
  LintScope,
  RuleWarning,
  WireLintBlock,
} from "./types";
import {
  InlineDisableAccumulator,
  sanitiseRules,
  type LintDisableRange,
} from "./lintDisableWalker";

/** Block kinds exposed to Rust (mirrors BLOCK_KIND_MAP in offsetMap.ts). */
const BLOCK_KIND_BY_PM_TYPE: Record<string, BlockKind | undefined> = {
  paragraph: "paragraph",
  heading: "heading",
  blockquote: "blockquote",
  listItem: "listItem",
  tableCell: "tableCell",
};

/** PM node types that should not contribute blocks at all. */
const SKIP_PM_TYPES = new Set(["codeBlock", "image", "horizontalRule"]);

interface PmMark {
  type?: string;
  attrs?: Record<string, unknown>;
}

interface PmNode {
  type?: string;
  text?: string;
  content?: PmNode[];
  marks?: PmMark[];
  attrs?: Record<string, unknown>;
}

/**
 * Scene-wide disable directive extracted from ProseMirror JSON.
 * Same shape as `DisableDirective` on the wire — the two are
 * intentionally identical so `buildBlocksFromJson` can feed the
 * `lint_text` payload directly.
 */
type JsonDisable = LintDisableRange;

/**
 * Walk a ProseMirror JSON doc and build a LintBlock array compatible
 * with Rust's `lint_text` input. No ProseMirror-position bookkeeping —
 * project mode only needs scene-wide UTF-16 offsets for diagnostic
 * display and export.
 */
export function buildBlocksFromJson(jsonText: string): {
  blocks: WireLintBlock[];
  sceneText: string;
  disables: JsonDisable[];
} {
  if (!jsonText || !jsonText.trim())
    return { blocks: [], sceneText: "", disables: [] };
  let doc: PmNode;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return { blocks: [], sceneText: "", disables: [] };
  }

  const blocks: WireLintBlock[] = [];
  const disables: JsonDisable[] = [];
  // Scene-wide UTF-16 cursor. Blocks are joined by "\n" separators, so
  // we advance by 1 between blocks (matching offsetMap.ts semantics).
  let cursor = 0;
  let nextId = 0;

  function textOf(node: PmNode): string {
    if (node.text) return node.text;
    if (!node.content) return "";
    return node.content.map(textOf).join("");
  }

  function findLintDisableRules(node: PmNode): string[] | null {
    if (!node.marks) return null;
    for (const m of node.marks) {
      if (m.type !== "lintDisable") continue;
      return sanitiseRules(m.attrs?.rules);
    }
    return null;
  }

  /**
   * Walk a leaf block's children to surface `lintDisable` Mark runs,
   * feeding the shared accumulator that `offsetMap.ts` also uses.
   * Same output shape for the same document so both paths produce
   * identical directive lists.
   */
  function collectInlineDisables(node: PmNode, blockStart: number) {
    let inBlockOffset = 0;
    const acc = new InlineDisableAccumulator((d) => disables.push(d));

    const walk = (n: PmNode) => {
      if (!n.type) return;
      if (n.type === "ruby") {
        acc.flush();
        const base = (n.attrs?.base as string | undefined) ?? "";
        inBlockOffset += utf16Length(base);
        return;
      }
      if (n.type === "hardBreak") {
        acc.flush();
        inBlockOffset += 1;
        return;
      }
      if (n.text !== undefined) {
        const len = utf16Length(n.text);
        if (len > 0) {
          const sceneStart = blockStart + inBlockOffset;
          const sceneEnd = sceneStart + len;
          acc.push(sceneStart, sceneEnd, findLintDisableRules(n));
          inBlockOffset += len;
        }
        return;
      }
      // Non-text inline / container — recurse.
      n.content?.forEach(walk);
    };

    node.content?.forEach(walk);
    acc.flush();
  }

  function visit(node: PmNode) {
    const type = node.type;
    if (!type) return;
    if (SKIP_PM_TYPES.has(type)) return;

    const mapped = BLOCK_KIND_BY_PM_TYPE[type];
    if (mapped) {
      // If this block has nested blocks, act as passthrough (mirrors
      // offsetMap.ts logic so scene-wide offsets agree).
      const hasNested =
        node.content?.some((c) => c.type && BLOCK_KIND_BY_PM_TYPE[c.type]) ??
        false;
      if (hasNested) {
        // Passthrough block may itself carry `lintDisabled` — cover
        // every inner leaf block that gets emitted during recursion
        // with one directive so "disable this whole list item"
        // actually silences the contained paragraphs.
        const firstInnerIdx = blocks.length;
        node.content?.forEach(visit);
        const blockDisabled = sanitiseRules(node.attrs?.lintDisabled);
        if (blockDisabled && blocks.length > firstInnerIdx) {
          const firstInner = blocks[firstInnerIdx];
          const lastInner = blocks[blocks.length - 1];
          const rangeStart = firstInner.str_offset_start;
          const rangeEnd =
            lastInner.str_offset_start + utf16Length(lastInner.text);
          if (rangeEnd > rangeStart) {
            disables.push({
              rules: blockDisabled,
              range: { start: rangeStart, end: rangeEnd },
            });
          }
        }
        return;
      }
      if (blocks.length > 0) cursor += 1; // separator
      const text = textOf(node);
      const startOffset = cursor;
      blocks.push({
        id: nextId++,
        kind: mapped,
        text,
        str_offset_start: startOffset,
      });
      collectInlineDisables(node, startOffset);
      const blockDisabled = sanitiseRules(node.attrs?.lintDisabled);
      if (blockDisabled && text.length > 0) {
        disables.push({
          rules: blockDisabled,
          range: {
            start: startOffset,
            end: startOffset + utf16Length(text),
          },
        });
      }
      cursor = startOffset + utf16Length(text);
      return;
    }
    // Not a block — descend.
    node.content?.forEach(visit);
  }

  doc.content?.forEach(visit);

  const sceneText = blocks.map((b) => b.text).join("\n");
  return { blocks, sceneText, disables };
}

function utf16Length(s: string): number {
  // JS strings are natively UTF-16; `length` is already UTF-16 code units.
  return s.length;
}

export interface ScannedScene {
  sceneId: string;
  sceneTitle: string;
  sceneText: string;
  diagnostics: Diagnostic[];
  warnings: RuleWarning[];
}

export interface ProjectScanProgress {
  completed: number;
  total: number;
  currentSceneId: string | null;
  currentSceneTitle: string | null;
}

export interface ProjectScanResult {
  /** Per-scene results, ordered by the scene tree's sort order. */
  scenes: ScannedScene[];
  /** True when the run completed to the end. False = user cancelled. */
  finished: boolean;
  /** Cross-scene error (lint_text rejected the request, DB failure, …). */
  fatalError: string | null;
}

export interface ProjectScanOptions {
  projectId: string;
  language: LintLanguage;
  baseConfig: LintConfig;
  /** If true, include codex entries in each per-scene lint request. */
  includeCodex: boolean;
  signal: AbortSignal;
  onProgress?: (p: ProjectScanProgress) => void;
  onSceneComplete?: (scene: ScannedScene) => void;
}

async function fetchCodexEntries(): Promise<LintCodexEntry[]> {
  try {
    const rows = await listCodexEntries(getCurrentProjectId());
    const out: LintCodexEntry[] = [];
    for (const r of rows) {
      if (!r.name || !r.name.trim()) continue;
      let aliases: string[] = [];
      if (r.aliases) {
        try {
          const parsed = JSON.parse(r.aliases);
          if (Array.isArray(parsed)) {
            aliases = parsed.filter(
              (x): x is string => typeof x === "string" && x.length > 0,
            );
          }
        } catch {
          /* malformed JSON — skip aliases for this entry */
        }
      }
      out.push({ entry_id: r.id, canonical: r.name, aliases });
    }
    return out;
  } catch {
    return [];
  }
}

export async function scanProject(
  opts: ProjectScanOptions,
): Promise<ProjectScanResult> {
  const results: ScannedScene[] = [];
  const fatalError: string | null = null;

  // Pull every node for the project, then narrow to scenes.
  let allNodes: Awaited<ReturnType<typeof listNodes>>;
  try {
    allNodes = await listNodes(opts.projectId);
  } catch (e) {
    return {
      scenes: [],
      finished: false,
      fatalError: `failed to enumerate scenes: ${String(e)}`,
    };
  }
  const sceneNodes = allNodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const codexEntries = opts.includeCodex ? await fetchCodexEntries() : [];
  const total = sceneNodes.length;
  let completed = 0;

  opts.onProgress?.({
    completed: 0,
    total,
    currentSceneId: null,
    currentSceneTitle: null,
  });

  for (const node of sceneNodes) {
    if (opts.signal.aborted) {
      return { scenes: results, finished: false, fatalError };
    }
    opts.onProgress?.({
      completed,
      total,
      currentSceneId: node.id,
      currentSceneTitle: node.title,
    });

    let content: string;
    try {
      content = await loadSceneContent(node.id);
    } catch {
      // Couldn't load this one scene; skip but continue (don't abort
      // the whole run on a single-scene failure).
      completed += 1;
      continue;
    }
    const { blocks, sceneText, disables } = buildBlocksFromJson(content);
    if (blocks.length === 0) {
      completed += 1;
      continue;
    }
    const config: LintConfig = {
      ...opts.baseConfig,
      codex_entries: opts.includeCodex ? codexEntries : undefined,
    };
    const scope: LintScope = { kind: "scene", scene_id: node.id };
    try {
      const resp = await invoke<LintResponse>("lint_text", {
        blocks,
        language: opts.language,
        scope,
        config,
        disables,
      });
      const scanned: ScannedScene = {
        sceneId: node.id,
        sceneTitle: node.title,
        sceneText,
        diagnostics: resp.diagnostics,
        warnings: resp.warnings,
      };
      results.push(scanned);
      opts.onSceneComplete?.(scanned);
    } catch (e) {
      // Per-scene lint failure — log to warnings shape, continue.
      results.push({
        sceneId: node.id,
        sceneTitle: node.title,
        sceneText,
        diagnostics: [],
        warnings: [
          {
            rule_id: "core/project-scan",
            kind: "initFailed",
            message: `scene "${node.title}" のLintに失敗: ${String(e)}`,
          },
        ],
      });
    }
    completed += 1;
  }

  opts.onProgress?.({
    completed,
    total,
    currentSceneId: null,
    currentSceneTitle: null,
  });

  return { scenes: results, finished: true, fatalError };
}
