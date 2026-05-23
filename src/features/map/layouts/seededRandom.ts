/** Deterministic pseudo-random in [0, 1) from a numeric seed and node id. */
export function seededRandom(seed: number, nodeId: string): number {
  let h = seed | 0;
  for (let i = 0; i < nodeId.length; i++) {
    h = Math.imul(h ^ nodeId.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return ((h >>> 0) % 1_000_000) / 1_000_000;
}

/** Hash a string to a positive integer seed for force layout. */
export function hashStringToSeed(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 42;
}
