import { spawn } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CORPUS_PATH = path.join(
  REPO_ROOT,
  "src/features/related-scenes/liveEval/corpus.json",
);
const GENERATED_PATH = path.join(
  REPO_ROOT,
  "src/features/related-scenes/liveEval/embeddings.generated.json",
);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this Heavy evaluation`);
  return path.resolve(value);
}

async function runCommand(command, args, env = process.env) {
  await new Promise((resolve, reject) => {
    const { executable, commandArgs } = buildCommandInvocation(command, args);
    const child = spawn(executable, commandArgs, {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (exitCode === 0) resolve();
      else {
        reject(
          new Error(
            `${command} failed with ${signal ? `signal ${signal}` : `exit ${exitCode}`}`,
          ),
        );
      }
    });
  });
}

export function buildCommandInvocation(
  command,
  args,
  platform = process.platform,
) {
  if (platform === "win32" && command === "pnpm") {
    return {
      executable: "cmd.exe",
      commandArgs: ["/d", "/s", "/c", command, ...args],
    };
  }
  return { executable: command, commandArgs: args };
}

async function verifyGeneratedEmbeddings() {
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  const generated = JSON.parse(await readFile(GENERATED_PATH, "utf8"));
  const vectors = generated?.vectors;
  if (!vectors || typeof vectors !== "object") {
    throw new Error("related-scenes generator produced no vectors object");
  }
  const requiredKeys = ["ja", "en"].flatMap((language) => [
    ...corpus[language].scenes.map((scene) => `${language}:s:${scene.id}`),
    ...corpus[language].cases.map(
      (evaluationCase) => `${language}:q:${evaluationCase.id}`,
    ),
  ]);
  const missing = requiredKeys.filter(
    (key) => !Array.isArray(vectors[key]) || vectors[key].length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `related-scenes generator is missing vectors: ${missing.join(", ")}`,
    );
  }
}

async function readExistingGeneratedFile() {
  try {
    return await readFile(GENERATED_PATH);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreGeneratedFile(previousContents) {
  if (previousContents) {
    await writeFile(GENERATED_PATH, previousContents);
    return;
  }
  try {
    await unlink(GENERATED_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runRelatedScenesHeavyEvaluation() {
  const nodeModules = requiredEnvironment("EMBED_NODE_MODULES");
  const resources = requiredEnvironment("EMBED_RES_DIR");
  await Promise.all([
    access(resources),
    access(path.join(nodeModules, "onnxruntime-node")),
    access(path.join(nodeModules, "@huggingface/transformers")),
  ]);

  const previousContents = await readExistingGeneratedFile();
  try {
    await runCommand(process.execPath, ["scripts/relatedScenesLiveEmbed.mjs"], {
      ...process.env,
      EMBED_NODE_MODULES: nodeModules,
      EMBED_RES_DIR: resources,
    });
    await verifyGeneratedEmbeddings();
    await runCommand(
      "pnpm",
      [
        "test:node",
        "--run",
        "src/features/related-scenes/liveEval/relatedScenesLive.eval.test.ts",
      ],
      { ...process.env, RS_EVAL_REPORT: "1" },
    );
  } finally {
    await restoreGeneratedFile(previousContents);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runRelatedScenesHeavyEvaluation().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
