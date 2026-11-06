// 診断（diagnostic only）専用の launcher。Anthropic の key を取得して、live の診断を走らせる。
//
// 使い方:
//   node scripts/quality/chronicle-prompt-cache-diag/run.mjs [--product-key-store <ai-keys.json>] [--check-key]
//
// key の取得（値は表示・記録しない）:
//   1. env ANTHROPIC_API_KEY
//   2. 製品の profile の ai-keys.json（既定 ~/.local/share/com.miyakey.grimodex/ai-keys.json）を
//      Electron の safeStorage で復号し、FIFO で受け取る（key-source.mjs）。
// 受け取った key は子の vitest の env ANTHROPIC_API_KEY にだけ渡す（ディスクに残さない）。
//
// 任意の env: GDX_DIAG_MODEL（既定 claude-sonnet-5-5）、GDX_DIAG_RUNS（既定 2）、
//   GDX_DIAG_CASE_IDS（カンマ区切りで case を固定）、GDX_DIAG_OUTPUT_ROOT。
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveAnthropicKey } from "./key-source.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const storeAt = argv.indexOf("--product-key-store");
const productKeyStore = storeAt >= 0 ? argv[storeAt + 1] : undefined;

const { key, via } = await resolveAnthropicKey({ productKeyStore });
process.stdout.write(`[diag] key を取得した（経路 ${via}）。値は出さない\n`);
if (argv.includes("--check-key")) process.exit(0);

const vitest = path.join(ROOT, "node_modules/.bin/vitest");
const child = spawn(
  vitest,
  [
    "--config",
    path.join(HERE, "vitest.config.mjs"),
    "--run",
    path.join(HERE, "run-diag.live.test.ts"),
  ],
  {
    cwd: ROOT,
    env: { ...process.env, ANTHROPIC_API_KEY: key },
    stdio: "inherit",
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
