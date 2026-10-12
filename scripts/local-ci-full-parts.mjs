// Canonical Full split across hosted jobs. Each part job runs the tasks it
// owns (plus explicitly reviewed support tasks whose build outputs those tasks
// consume) on its own fresh VM and writes a part report. One aggregate job
// assembles the single Full receipt from every part and verifies it.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const FULL_PARTS_VERSION = "local-ci-full-parts/1";
export const FULL_PART_REPORT_VERSION = "local-ci-full-part/1";
export const FULL_PARTS_PATH = "scripts/local-ci-full-parts.json";
// The part that runs native B (journeys.shard-1) owns the private gate,
// the C2-ZC fixture and every product journey.
export const FULL_PRIVATE_GATE_TASK = "journeys.shard-1";
const PART_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function fullPartsDigest(config) {
  return digest(config);
}

export async function readFullParts(root) {
  return JSON.parse(await readFile(path.join(root, FULL_PARTS_PATH), "utf8"));
}

export function validateFullParts(config, plan) {
  if (plan?.profile !== "full" || !Array.isArray(plan.tasks)) throw new Error("Full parts require the complete Full plan");
  if (config?.version !== FULL_PARTS_VERSION || !Array.isArray(config.parts) || config.parts.length < 2) {
    throw new Error(`Full parts must be ${FULL_PARTS_VERSION} with at least two parts`);
  }
  const taskIds = new Set(plan.tasks.map(({ id }) => id));
  const owner = new Map();
  const ids = new Set();
  for (const part of config.parts) {
    if (!PART_ID.test(part?.id ?? "") || ids.has(part.id)) throw new Error("Full part ids must be unique short identifiers");
    ids.add(part.id);
    if (!Array.isArray(part.owned) || !part.owned.length || !Array.isArray(part.support)) {
      throw new Error(`Full part ${part.id} needs owned and support task lists`);
    }
    for (const id of part.owned) {
      if (!taskIds.has(id)) throw new Error(`Full part ${part.id} owns unknown task ${id}`);
      if (owner.has(id)) throw new Error(`Full task ${id} is owned by more than one part`);
      owner.set(id, part.id);
    }
  }
  for (const id of taskIds) if (!owner.has(id)) throw new Error(`Full task ${id} is not owned by any part`);
  for (const part of config.parts) {
    const local = new Set(part.owned);
    for (const id of part.support) {
      if (!taskIds.has(id) || local.has(id) || new Set(part.support).size !== part.support.length) {
        throw new Error(`Full part ${part.id} support task ${id} must be a distinct task owned elsewhere`);
      }
    }
  }
  // The private gate, fixture and journeys must share one VM and one owner.
  const journeys = owner.get(FULL_PRIVATE_GATE_TASK);
  for (const id of taskIds) {
    if ((id.startsWith("journeys.") || id.startsWith("c2zc.")) && owner.get(id) !== journeys) {
      throw new Error(`Full task ${id} must share the private-gate part`);
    }
  }
  return { owner, privateGatePart: journeys };
}

export function buildFullPartTasks(plan, config, partId) {
  const part = config.parts.find(({ id }) => id === partId);
  if (!part) throw new Error(`Unknown Full part: ${partId}`);
  const owned = new Set(part.owned);
  const support = new Set(part.support);
  const included = new Set([...owned, ...support]);
  // Dependencies owned by other parts and not supported here are ordering-only
  // for this VM; the aggregate requires them to have passed in their own part.
  const tasks = plan.tasks
    .filter(({ id }) => included.has(id))
    .map((task) => ({ ...task, after: (task.after ?? []).filter((id) => included.has(id)) }));
  return { part, tasks, owned, support };
}

// One shared UUIDv4 for every part and the aggregate of a workflow attempt.
export function canonicalGithubRunId(env = process.env) {
  const runId = env.GITHUB_RUN_ID, attempt = env.GITHUB_RUN_ATTEMPT;
  if (env.RUNNER_ENVIRONMENT !== "github-hosted" || !/^[1-9][0-9]*$/u.test(runId ?? "") || !/^[1-9][0-9]*$/u.test(attempt ?? "")) {
    throw new Error("Split canonical Full requires a GitHub-hosted workflow run and attempt");
  }
  const hex = createHash("sha256").update(`grimodex-canonical-full\0${env.GITHUB_REPOSITORY ?? ""}\0${runId}\0${attempt}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function fullPartReportPath(partId) {
  return path.posix.join(".artifacts", "local-ci", "parts", `${partId}.json`);
}

export function supportLogDirectory(runId, partId) {
  return path.posix.join(".artifacts", "local-ci", "runs", runId, "support", partId, "logs");
}

// Assemble the single Full receipt body from validated part reports. Command
// records and task results come only from the owning part, in plan order.
export function assembleFullFromParts({ plan, config, reports, candidate, runId, planDescriptor }) {
  const { owner, privateGatePart } = validateFullParts(config, plan);
  if (!UUID_V4.test(runId)) throw new Error("Split Full run id must be a UUIDv4");
  const byPart = new Map();
  for (const part of config.parts) {
    const report = reports.get(part.id);
    if (!report || report.version !== FULL_PART_REPORT_VERSION || report.part !== part.id ||
        report.partsDigest !== fullPartsDigest(config) || report.registryDigest !== plan.registryDigest ||
        report.planDigest !== digest(planDescriptor) || report.runId !== runId || report.status !== "passed") {
      throw new Error(`Full part ${part.id} report is missing, failed or bound to another plan/run`);
    }
    for (const field of ["candidate", "candidateAfter"]) {
      for (const key of ["resolvedBaseSha", "resolvedHeadSha", "resolvedHeadTreeSha", "currentHeadSha", "worktreeClean", "worktreeFingerprint", "worktreeStatusHash", "requestedBase", "requestedHead"]) {
        if (report[field]?.[key] !== candidate[key]) throw new Error(`Full part ${part.id} ${field} does not match the candidate: ${key}`);
      }
    }
    const ownedIds = plan.tasks.filter(({ id }) => owner.get(id) === part.id).map(({ id }) => id);
    if (JSON.stringify(report.tasks?.map(({ id }) => id)) !== JSON.stringify(ownedIds) ||
        JSON.stringify(Object.keys(report.commands ?? {}).sort()) !== JSON.stringify([...ownedIds].sort())) {
      throw new Error(`Full part ${part.id} must report exactly its owned tasks`);
    }
    if (part.id !== privateGatePart && (report.fullResourceAdmission != null || report.productJourneyEvidence != null || report.c2zcRestoreFixture != null)) {
      throw new Error(`Full part ${part.id} must not carry private-gate or journey evidence`);
    }
    byPart.set(part.id, report);
  }
  const results = new Map();
  const commands = new Map();
  for (const report of byPart.values()) {
    for (const task of report.tasks) results.set(task.id, task);
    for (const [id, command] of Object.entries(report.commands)) commands.set(id, command);
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
  const journeys = byPart.get(privateGatePart);
  const started = Math.min(...[...byPart.values()].map(({ startedAt }) => Date.parse(startedAt)));
  const finished = Math.max(...[...byPart.values()].map(({ finishedAt }) => Date.parse(finishedAt)));
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) throw new Error("Full part timing is invalid");
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    executionDurationMs: finished - started,
    tasks,
    stages,
    privateGatePart,
    c2zcRestoreFixture: journeys.c2zcRestoreFixture ?? null,
    productJourneyEvidence: journeys.productJourneyEvidence ?? null,
    fullResourceAdmission: journeys.fullResourceAdmission ?? null,
    privateOutcome: journeys.privateOutcome ?? null,
  };
}
