/** Freeze an extraction artifact recursively before it crosses an async boundary. */
export function freezeDeep<T>(value: T): T {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Object.isFrozen(candidate) ||
      seen.has(candidate)
    ) {
      return;
    }

    seen.add(candidate);
    for (const child of Object.values(candidate)) visit(child);
    Object.freeze(candidate);
  };

  visit(value);
  return value;
}
