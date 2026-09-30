import assert from "node:assert/strict";
import test from "node:test";

import { runLocalCiTasks, validateLocalCiTasks } from "./local-ci-runner.mjs";

const pass = (extra = {}) => ({
  cleanup: { complete: true },
  exitCode: 0,
  signal: null,
  ...extra,
});

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("validates IDs, dependencies, slots, and cycles", () => {
  assert.throws(
    () => validateLocalCiTasks([{ id: "same" }, { id: "same" }]),
    /duplicate task id/u,
  );
  assert.throws(
    () => validateLocalCiTasks([{ id: "task", after: ["missing"] }]),
    /unknown dependency/u,
  );
  assert.throws(
    () =>
      validateLocalCiTasks([
        { id: "a", after: ["b"] },
        { id: "b", after: ["a"] },
      ]),
    /cycle/u,
  );
  assert.throws(
    () => validateLocalCiTasks([{ id: "wide", slots: 3 }], { maxSlots: 2 }),
    /slots/u,
  );
});

test("honors dependencies, named lanes, and the global slot bound", async () => {
  const events = [];
  let usedSlots = 0;
  let peakSlots = 0;
  const laneCounts = new Map();
  const tasks = [
    { id: "prepare", slots: 2 },
    { id: "browser-a", after: ["prepare"], lane: "browser", slots: 2 },
    { id: "browser-b", after: ["prepare"], lane: "browser", slots: 1 },
    { id: "unit", after: ["prepare"], slots: 1 },
  ];

  const result = await runLocalCiTasks(tasks, {
    maxSlots: 3,
    async executeTask(task) {
      usedSlots += task.slots ?? 1;
      peakSlots = Math.max(peakSlots, usedSlots);
      if (task.lane) {
        const count = (laneCounts.get(task.lane) ?? 0) + 1;
        laneCounts.set(task.lane, count);
        assert.equal(count, 1, `lane ${task.lane} overlapped`);
      }
      events.push(`start:${task.id}`);
      await delay(task.id === "browser-a" ? 25 : 10);
      events.push(`end:${task.id}`);
      if (task.lane) laneCounts.set(task.lane, laneCounts.get(task.lane) - 1);
      usedSlots -= task.slots ?? 1;
      return pass();
    },
  });

  assert.equal(result.status, "passed");
  assert.ok(peakSlots <= 3);
  assert.ok(events.indexOf("end:prepare") < events.indexOf("start:browser-a"));
  assert.ok(events.indexOf("end:prepare") < events.indexOf("start:unit"));
  assert.ok(
    events.indexOf("end:browser-a") < events.indexOf("start:browser-b"),
  );
  assert.deepEqual(
    result.tasks.map(({ id, status }) => [id, status]),
    tasks.map(({ id }) => [id, "passed"]),
  );
});

test("stops admission after failure and waits for admitted work", async () => {
  const events = [];
  const result = await runLocalCiTasks(
    [{ id: "fail" }, { id: "running" }, { id: "later", after: ["fail"] }],
    {
      maxSlots: 2,
      async executeTask(task) {
        events.push(`start:${task.id}`);
        if (task.id === "fail") await delay(5);
        if (task.id === "running") await delay(30);
        events.push(`end:${task.id}`);
        return task.id === "fail" ? pass({ exitCode: 2 }) : pass();
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(events, [
    "start:fail",
    "start:running",
    "end:fail",
    "end:running",
  ]);
  assert.equal(result.tasks.find(({ id }) => id === "fail").status, "failed");
  assert.equal(
    result.tasks.find(({ id }) => id === "running").status,
    "passed",
  );
  assert.equal(result.tasks.find(({ id }) => id === "later").status, "not-run");
});

test("aborts admitted work at the global deadline and admits nothing else", async () => {
  const started = [];
  const result = await runLocalCiTasks(
    [{ id: "slow" }, { id: "later", after: ["slow"] }],
    {
      deadlineMs: 40,
      maxSlots: 1,
      executeTask(task, { signal }) {
        started.push(task.id);
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () =>
              resolve(
                pass({
                  interrupted: true,
                }),
              ),
            { once: true },
          );
        });
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.deadlineExceeded, true);
  assert.deepEqual(started, ["slow"]);
  assert.equal(result.tasks[0].status, "failed");
  assert.equal(result.tasks[1].status, "not-run");
});
