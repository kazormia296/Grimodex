let loadDepth = 0;
const waiters: Array<() => void> = [];

export function isProjectLoading(): boolean {
  return loadDepth > 0;
}

export async function withProjectLoad<T>(fn: () => Promise<T>): Promise<T> {
  loadDepth++;
  try {
    return await fn();
  } finally {
    loadDepth--;
    if (loadDepth === 0) {
      for (const resolve of waiters.splice(0)) {
        resolve();
      }
    }
  }
}

export function whenProjectLoadDone(): Promise<void> {
  if (loadDepth === 0) return Promise.resolve();
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

/** Test helper */
export function resetProjectLoadGateForTests(): void {
  loadDepth = 0;
  waiters.length = 0;
}
