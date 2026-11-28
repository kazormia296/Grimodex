export const PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
} as const;
export function estimateCost(
  model: keyof typeof PRICES,
  inputTokens: number,
  maxTokens: number,
): number {
  const price = PRICES[model];
  return (inputTokens * price.input + maxTokens * price.output) / 1_000_000;
}
export function assertWithinCap(total: number, cap = 3): void {
  if (!Number.isFinite(total) || total < 0 || total > cap)
    throw new Error(
      `Estimated cost $${total.toFixed(4)} exceeds cap $${cap.toFixed(2)}; no requests sent`,
    );
}
