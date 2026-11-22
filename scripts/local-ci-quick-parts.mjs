// Canonical Quick split across hosted jobs. Each part job runs one registry
// task (`impact.select.<n>`, a subset of the selected Light commands run in
// selection order, serially) on its own fresh VM and writes a part report. One
// aggregate job assembles the single Quick receipt from every part and checks
// that the parts together ran exactly the unsplit selection.
import { createHash } from "node:crypto";
import path from "node:path";

import { IMPACT_PART_COUNT, impactSelectionDigest } from "./local-ci-impact-parts.mjs";

export const QUICK_PARTS_VERSION = "local-ci-quick-parts/1";
export const QUICK_PART_REPORT_VERSION = "local-ci-quick-part/1";
const QUICK_TASK_ID = /^impact\.select\.([1-9])$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANDIDATE_KEYS = ["resolvedBaseSha", "resolvedHeadSha", "resolvedHeadTreeSha", "currentHeadSha",
  "worktreeClean", "worktreeFingerprint", "worktreeStatusHash", "requestedBase", "requestedHead"];

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

// The registry owns the partition: Quick's tasks are exactly impact.select.1..N
// and each one passes `--part <n>/N` to the selector.
export function quickParts(plan) {
  if (plan?.profile !== "quick" || !Array.isArray(plan.tasks)) throw new Error("Quick parts require the complete Quick plan");
  if (plan.tasks.length !== IMPACT_PART_COUNT) {
    throw new Error(`Quick must plan exactly ${IMPACT_PART_COUNT} impact parts`);
  }
  return plan.tasks.map((task, index) => {
    const id = String(index + 1);
    const args = task.command?.args ?? [];
    const partArgument = args[args.indexOf("--part") + 1];
    if (task.id !== `impact.select.${id}` || !QUICK_TASK_ID.test(task.id) ||
        args.indexOf("--part") === -1 || partArgument !== `${id}/${IMPACT_PART_COUNT}` ||
        args.filter((argument) => argument === "--part").length !== 1) {
      throw new Error(`Quick task ${task.id} must be impact.select.${id} running --part ${id}/${IMPACT_PART_COUNT}`);
    }
    return { id, taskId: task.id };
  });
}

export function quickPartsDigest(plan) {
  return digest({ version: QUICK_PARTS_VERSION, parts: quickParts(plan) });
}

export function quickPartReportPath(partId) {
  return path.posix.join(".artifacts", "local-ci", "parts", `quick-${partId}.json`);
}

export function buildQuickPartTasks(plan, partId) {
  const part = quickParts(plan).find(({ id }) => id === partId);
  if (!part) throw new Error(`Unknown Quick part: ${partId}`);
  // Parts run on separate VMs; the local chain only orders them in one process.
  const tasks = plan.tasks.filter(({ id }) => id === part.taskId).map((task) => ({ ...task, after: [] }));
  return { part, tasks, owned: new Set([part.taskId]) };
}

// The selector's own report of what this part ran, reduced to what coverage
// checking needs.
export function summarizeQuickPartImpact(report) {
  if (!report?.selection || !Array.isArray(report.execution) || !report.part) {
    throw new Error("Quick part impact report must carry its selection, part and execution");
  }
  return {
    part: report.part,
    selectionDigest: impactSelectionDigest(report.selection),
    suiteIds: report.selection.suiteIds,
    executed: report.execution.map(({ suiteId, commands, steps, status }) => ({
      suiteId, commands, status, stepStatuses: steps.map((step) => step.status),
    })),
  };
}

// What part `index` must have run, grouped by suite, from the selector's
// command plan (every selected command with the part that runs it).
export function expectedQuickPartExecution(commandPlan, index) {
  const grouped = [];
  for (const entry of commandPlan.filter(({ part }) => part === index)) {
    const last = grouped.at(-1);
    if (last?.suiteId === entry.suiteId) last.commands.push(entry.command);
    else grouped.push({ suiteId: entry.suiteId, commands: [entry.command] });
  }
  return grouped;
}

// Every part ran from the same selection, exactly its assigned commands, all
// passed; together the parts ran each planned command once. `selection` and
// `commandPlan` are recomputed independently by the caller from base/head.
export function checkQuickPartCoverage({ reports, selection, commandPlan, count = IMPACT_PART_COUNT }) {
  const expectedDigest = impactSelectionDigest(selection);
  const planned = new Set();
  for (const entry of commandPlan) {
    const key = `${entry.suiteId}#${entry.stepIndex}`;
    if (planned.has(key) || !selection.suiteIds.includes(entry.suiteId) ||
        !Number.isInteger(entry.part) || entry.part < 1 || entry.part > count) {
      throw new Error(`Quick command plan has a duplicate, unselected or unassigned command: ${key}`);
    }
    planned.add(key);
  }
  let executedCommands = 0;
  for (let index = 1; index <= count; index += 1) {
    const impact = reports.get(String(index))?.impact;
    if (!impact || impact.part?.index !== index || impact.part?.count !== count) {
      throw new Error(`Quick part ${index} impact summary is missing or names another part`);
    }
    if (impact.selectionDigest !== expectedDigest || JSON.stringify(impact.suiteIds) !== JSON.stringify(selection.suiteIds)) {
      throw new Error(`Quick part ${index} ran a different impact selection than base/head selects`);
    }
    const actual = impact.executed.map(({ suiteId, commands }) => ({ suiteId, commands }));
    if (JSON.stringify(actual) !== JSON.stringify(expectedQuickPartExecution(commandPlan, index))) {
      throw new Error(`Quick part ${index} did not run exactly its assigned commands`);
    }
    if (!impact.executed.every(({ status, stepStatuses }) => status === "passed" && stepStatuses.every((step) => step === "passed"))) {
      throw new Error(`Quick part ${index} has a command that did not pass`);
    }
    executedCommands += impact.executed.reduce((total, { commands }) => total + commands.length, 0);
  }
  if (executedCommands !== planned.size) {
    throw new Error(`Quick parts ran ${executedCommands} commands but the selection has ${planned.size}`);
  }
  return { selectedCommands: planned.size };
}

// Assemble the single Quick receipt body from validated part reports. Task
// results and command records come only from the owning part, in plan order.
export function assembleQuickFromParts({ plan, reports, candidate, runId, planDescriptor }) {
  const parts = quickParts(plan);
  if (!UUID_V4.test(runId)) throw new Error("Split Quick run id must be a UUIDv4");
  const results = new Map();
  const commands = new Map();
  for (const part of parts) {
    const report = reports.get(part.id);
    if (!report || report.version !== QUICK_PART_REPORT_VERSION || report.part !== part.id ||
        report.partsDigest !== quickPartsDigest(plan) || report.registryDigest !== plan.registryDigest ||
        report.planDigest !== digest(planDescriptor) || report.runId !== runId || report.status !== "passed") {
      throw new Error(`Quick part ${part.id} report is missing, failed or bound to another plan/run`);
    }
    for (const field of ["candidate", "candidateAfter"]) {
      for (const key of CANDIDATE_KEYS) {
        if (report[field]?.[key] !== candidate[key]) throw new Error(`Quick part ${part.id} ${field} does not match the candidate: ${key}`);
      }
    }
    if (JSON.stringify(report.tasks?.map(({ id }) => id)) !== JSON.stringify([part.taskId]) ||
        JSON.stringify(Object.keys(report.commands ?? {})) !== JSON.stringify([part.taskId])) {
      throw new Error(`Quick part ${part.id} must report exactly its owned task`);
    }
    results.set(part.taskId, report.tasks[0]);
    commands.set(part.taskId, report.commands[part.taskId]);
  }
  const tasks = plan.tasks.map(({ id }) => results.get(id));
  const stages = plan.stages.map((stage) => {
    const stageCommands = stage.commands.map((planned) => ({ ...commands.get(planned.id), ...results.get(planned.id) }));
    return {
      id: stage.id,
      label: stage.label,
      status: stageCommands.every(({ status }) => status === "passed") ? "passed" : "failed",
      durationMs: stageCommands.reduce((total, command) => total + (command.durationMs ?? 0), 0),
      commands: stageCommands,
    };
  });
  const started = Math.min(...parts.map(({ id }) => Date.parse(reports.get(id).startedAt)));
  const finished = Math.max(...parts.map(({ id }) => Date.parse(reports.get(id).finishedAt)));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error("Quick part timing is invalid");
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    executionDurationMs: finished - started,
    tasks,
    stages,
  };
}
