import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveAnthropicKey } from "../chronicle-prompt-cache-diag/key-source.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const opts = {
  model: "claude-haiku-5-5",
  effort: "low",
  reps: "3",
  cap: "3",
  max_tokens: "4000",
};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const key = args[i].replace(/^--/u, "");
  if (!(key in opts) || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Invalid argument: ${args[i]}`);
  opts[key] = args[++i];
}
if (
  !/^[1-9]\d*$/u.test(opts.reps) ||
  !/^[1-9]\d*$/u.test(opts.max_tokens) ||
  !Number.isFinite(Number(opts.cap)) ||
  Number(opts.cap) <= 0
)
  throw new Error("reps, cap and max_tokens must be positive");
if (!(opts.model in { "claude-haiku-5-5": 1, "claude-sonnet-5-5": 1 }))
  throw new Error("model must be claude-haiku-5-5 or claude-sonnet-5-5");
if (!new Set(["low", "medium", "high"]).has(opts.effort))
  throw new Error("effort must be low, medium or high");
const { key } = await resolveAnthropicKey();
const child = spawn(
  path.join(root, "node_modules/.bin/vitest"),
  [
    "--config",
    path.join(here, "vitest.config.mjs"),
    "--run",
    path.join(here, "run-eval.live.test.ts"),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: key,
      B1_MODEL: opts.model,
      B1_EFFORT: opts.effort,
      B1_REPS: opts.reps,
      B1_CAP: opts.cap,
      B1_MAX_TOKENS: opts.max_tokens,
    },
    stdio: "inherit",
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
