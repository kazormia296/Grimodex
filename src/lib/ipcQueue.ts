type QueueItem<T> = {
  cmd: string;
  run: () => Promise<T>;
  timeoutMs: number;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

const MAX_CONCURRENT = 4;

let queue: QueueItem<unknown>[] = [];
let activeCount = 0;

function runWithTimeout<T>(item: QueueItem<T>): Promise<void> {
  return new Promise<void>((done) => {
    const timerId = setTimeout(() => {
      item.reject(new Error(`IPC timeout after ${item.timeoutMs}ms: ${item.cmd}`));
      done();
    }, item.timeoutMs);

    item
      .run()
      .then(
        (value) => {
          clearTimeout(timerId);
          item.resolve(value);
        },
        (error) => {
          clearTimeout(timerId);
          item.reject(error);
        },
      )
      .finally(done);
  });
}

function pumpQueue(): void {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!;
    activeCount++;
    void runWithTimeout(item).finally(() => {
      activeCount--;
      pumpQueue();
    });
  }
}

/** Serialize burst IPC so timeouts measure execution time, not queue wait. */
export function enqueueIpc<T>(
  cmd: string,
  run: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      cmd,
      run,
      timeoutMs,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    pumpQueue();
  });
}

/** Test helper */
export function resetIpcQueueForTests(): void {
  queue = [];
  activeCount = 0;
}
