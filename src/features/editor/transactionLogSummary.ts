interface StepContentLike {
  size?: number;
  textBetween?: (from: number, to: number, blockSeparator?: string) => string;
}

interface TransactionStepLike {
  from?: unknown;
  to?: unknown;
  slice?: { content?: StepContentLike };
  constructor?: { name?: string };
}

export interface TransactionStepLogSummary {
  stepType: string;
  from: number | null;
  to: number | null;
  insertedChars: number;
}

function finitePosition(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stepType(step: TransactionStepLike): string {
  const constructorName = step.constructor?.name ?? "UnknownStep";
  const withoutSuffix = constructorName.replace(/Step$/, "") || "Unknown";
  return withoutSuffix.charAt(0).toLowerCase() + withoutSuffix.slice(1);
}

function insertedCharacterCount(step: TransactionStepLike): number {
  const content = step.slice?.content;
  if (!content) return 0;
  const size =
    typeof content.size === "number" && Number.isFinite(content.size)
      ? Math.max(0, content.size)
      : 0;
  if (!content.textBetween) return size;
  try {
    return content.textBetween(0, size, "\n").length;
  } catch {
    // Custom/atomic nodes may not expose textBetween consistently. The
    // ProseMirror content size is still a safe, content-free approximation.
    return size;
  }
}

/**
 * Produce the only transaction shape allowed in debug logs. In particular,
 * this never serializes a Step or returns inserted text/marks/attributes.
 */
export function summarizeTransactionSteps(
  steps: readonly unknown[],
): TransactionStepLogSummary[] {
  return steps.map((value) => {
    const step: TransactionStepLike =
      value !== null && typeof value === "object"
        ? (value as TransactionStepLike)
        : {};
    return {
      stepType: stepType(step),
      from: finitePosition(step.from),
      to: finitePosition(step.to),
      insertedChars: insertedCharacterCount(step),
    };
  });
}
