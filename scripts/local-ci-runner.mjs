import { performance } from "node:perf_hooks";

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function taskSlots(task) {
  return task.slots ?? 1;
}

export function validateLocalCiTasks(tasks, { maxSlots = 1 } = {}) {
  requirePositiveInteger(maxSlots, "local CI maxSlots");
  if (!Array.isArray(tasks)) throw new Error("local CI tasks must be an array");

  const byId = new Map();
  for (const [index, task] of tasks.entries()) {
    if (
      task === null ||
      typeof task !== "object" ||
      Array.isArray(task) ||
      typeof task.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/u.test(task.id)
    ) {
      throw new Error(`local CI task ${index} has an invalid id`);
    }
    if (byId.has(task.id)) {
      throw new Error(`local CI duplicate task id: ${task.id}`);
    }
    const after = task.after ?? [];
    if (
      !Array.isArray(after) ||
      after.some((id) => typeof id !== "string") ||
      new Set(after).size !== after.length
    ) {
      throw new Error(`local CI task ${task.id} has invalid dependencies`);
    }
    if (
      task.lane !== undefined &&
      (typeof task.lane !== "string" || task.lane.length === 0)
    ) {
      throw new Error(`local CI task ${task.id} has an invalid lane`);
    }
    if (taskSlots(task) > maxSlots) {
      throw new Error(`local CI task ${task.id} slots exceed maxSlots`);
    }
    requirePositiveInteger(taskSlots(task), `local CI task ${task.id} slots`);
    byId.set(task.id, task);
  }

  for (const task of tasks) {
    for (const dependency of task.after ?? []) {
      if (!byId.has(dependency)) {
        throw new Error(
          `local CI task ${task.id} has unknown dependency ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`local CI task cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).after ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function failedExecution(error) {
  const supplied = error?.result;
  return {
    ...(supplied && typeof supplied === "object" ? supplied : {}),
    cleanup: supplied?.cleanup ?? { complete: false },
    error: supplied?.error ?? errorMessage(error),
    exitCode: supplied?.exitCode ?? null,
    signal: supplied?.signal ?? null,
  };
}

function taskPassed(execution) {
  return (
    execution?.exitCode === 0 &&
    execution?.signal == null &&
    execution?.cleanup?.complete === true &&
    execution?.interrupted !== true &&
    execution?.timedOut !== true &&
    execution?.error === undefined
  );
}

function notRunResult(task, reason) {
  return {
    id: task.id,
    cleanup: { complete: true },
    durationMs: 0,
    exitCode: null,
    reason,
    signal: null,
    status: "not-run",
  };
}

export async function runLocalCiTasks(
  tasks,
  {
    deadlineMs = Number.POSITIVE_INFINITY,
    executeTask,
    maxSlots = 1,
    maxParallelTasks = maxSlots,
    notify = () => {},
    signal = null,
  } = {},
) {
  validateLocalCiTasks(tasks, { maxSlots });
  requirePositiveInteger(maxParallelTasks, "local CI maxParallelTasks");
  if (maxParallelTasks > maxSlots) {
    throw new Error("local CI maxParallelTasks must not exceed maxSlots");
  }
  if (typeof executeTask !== "function") {
    throw new Error("local CI executeTask must be a function");
  }
  if (
    deadlineMs !== Number.POSITIVE_INFINITY &&
    (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
  ) {
    throw new Error("local CI deadlineMs must be positive");
  }

  const started = performance.now();
  const controller = new AbortController();
  let deadlineExceeded = false;
  let interrupted = false;
  let admissionStopped = false;
  let stopReason = null;
  let usedSlots = 0;
  const activeLanes = new Set();
  const startedIds = new Set();
  const results = new Map();
  const running = new Map();

  const stopForSignal = () => {
    interrupted = true;
    admissionStopped = true;
    stopReason = "Interrupted before admission.";
    controller.abort(signal?.reason ?? new Error("local CI interrupted"));
  };
  if (signal?.aborted) stopForSignal();
  else signal?.addEventListener("abort", stopForSignal, { once: true });

  const deadlineTimer = Number.isFinite(deadlineMs)
    ? setTimeout(() => {
        deadlineExceeded = true;
        admissionStopped = true;
        stopReason = "Global deadline exceeded before admission.";
        controller.abort(new Error("local CI global deadline exceeded"));
      }, deadlineMs)
    : null;

  const startTask = (task) => {
    const slots = taskSlots(task);
    usedSlots += slots;
    if (task.lane) activeLanes.add(task.lane);
    startedIds.add(task.id);
    notify({ task, type: "task-start" });
    const promise = Promise.resolve()
      .then(() => executeTask(task, { signal: controller.signal }))
      .catch(failedExecution)
      .then((execution) => {
        const result = {
          id: task.id,
          ...execution,
          status: taskPassed(execution) ? "passed" : "failed",
        };
        results.set(task.id, result);
        usedSlots -= slots;
        if (task.lane) activeLanes.delete(task.lane);
        running.delete(task.id);
        notify({ result, task, type: "task-end" });
        if (result.status === "failed" && !admissionStopped) {
          admissionStopped = true;
          stopReason = `Fail-fast after ${task.id}.`;
        }
        return result;
      });
    running.set(task.id, promise);
  };

  try {
    while (results.size < tasks.length) {
      let admitted = false;
      if (!admissionStopped) {
        for (const task of tasks) {
          if (running.size >= maxParallelTasks) break;
          if (startedIds.has(task.id)) continue;
          if (
            (task.after ?? []).some(
              (dependency) => results.get(dependency)?.status !== "passed",
            )
          ) {
            continue;
          }
          if (usedSlots + taskSlots(task) > maxSlots) continue;
          if (task.lane && activeLanes.has(task.lane)) continue;
          startTask(task);
          admitted = true;
        }
      }

      if (running.size > 0) {
        await Promise.race(running.values());
        continue;
      }
      if (!admitted) break;
    }
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    signal?.removeEventListener("abort", stopForSignal);
  }

  if (running.size > 0) await Promise.allSettled(running.values());
  const reason = stopReason ?? "Dependency did not pass.";
  for (const task of tasks) {
    if (!results.has(task.id)) results.set(task.id, notRunResult(task, reason));
  }
  const orderedResults = tasks.map((task) => results.get(task.id));
  return {
    deadlineExceeded,
    durationMs: Math.round(performance.now() - started),
    interrupted,
    status:
      !deadlineExceeded &&
      !interrupted &&
      orderedResults.every(({ status }) => status === "passed")
        ? "passed"
        : "failed",
    tasks: orderedResults,
  };
}
