/**
 * Shared walker helpers for collecting `lintDisable` directives.
 *
 * `offsetMap.ts` walks live ProseMirror documents; `projectScan.ts`
 * walks stored JSON. The two had diverged implementations of the same
 * run-accumulator algorithm — this module hosts the single source of
 * truth so fixes to the merging logic land in one place.
 */

export interface LintDisableRange {
  rules: string[];
  range: { start: number; end: number };
}

/**
 * Normalise a rules input (from TipTap attrs / JSON marks) into a
 * non-empty `string[]`. Returns `null` when the input is not a valid
 * selector payload — the caller drops the directive in that case,
 * matching the engine's behaviour where invalid selectors are skipped
 * with a warning.
 */
export function sanitiseRules(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  if (!raw.every((s) => typeof s === "string")) return null;
  return raw as string[];
}

export function sameRules(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Accumulates adjacent text segments that share a `lintDisable` rules
 * set into a single directive. Use the walker pattern:
 *
 *   const acc = new InlineDisableAccumulator(emit);
 *   for each text segment: acc.push(start, end, rulesOrNull);
 *   on block boundary / ruby / hardBreak: acc.flush();
 *
 * Segments with `null` rules flush the current run (representing a
 * break in disable coverage). Non-text boundaries also call `flush`
 * so a disable never extends across a ruby/hardBreak gap.
 */
export class InlineDisableAccumulator {
  private current: { rules: string[]; start: number; end: number } | null =
    null;
  private readonly emit: (d: LintDisableRange) => void;

  constructor(emit: (d: LintDisableRange) => void) {
    this.emit = emit;
  }

  push(sceneStart: number, sceneEnd: number, rules: string[] | null): void {
    if (!rules || sceneEnd <= sceneStart) {
      this.flush();
      return;
    }
    if (
      this.current &&
      this.current.end === sceneStart &&
      sameRules(this.current.rules, rules)
    ) {
      this.current.end = sceneEnd;
    } else {
      this.flush();
      this.current = { rules, start: sceneStart, end: sceneEnd };
    }
  }

  flush(): void {
    if (this.current) {
      this.emit({
        rules: this.current.rules,
        range: { start: this.current.start, end: this.current.end },
      });
      this.current = null;
    }
  }
}
